//! Window pixels for window follow, captured by a long-lived child process.
//!
//! macOS applies a Screen Recording grant only to processes that start after
//! it. Helper keeps running, so its pairing and Sync attachment survive the
//! grant, and asks this child to capture instead. The child reads requests
//! from stdin and answers on stdout until stdin closes.
//!
//! Request: `window <id> <top-fraction>\n`. Reply: one status byte, then `FRAME` pixel bytes
//! when the status is `OK`.

use std::{
    io::{self, BufRead, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use crate::window_follow;

pub const FLAG: &str = "--window-sampler";
const FRAME: usize = window_follow::SAMPLES;
const OK: u8 = 1;
const FAILED: u8 = 0;
/// The native capture gives up after 1.2 s, so a silent child is stuck.
const REPLY_TIMEOUT: Duration = Duration::from_secs(4);
/// Without this a child that keeps dying would be respawned for every sample.
const RESPAWN_AFTER_FAILURE: Duration = Duration::from_secs(1);

type Reply = Option<Vec<u8>>;

/// A running child and the thread that reads its replies.
struct Running {
    process: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<Reply>,
}

impl Running {
    fn start(command: &mut Command) -> io::Result<Self> {
        let mut process = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let (Some(input), Some(mut output)) = (process.stdin.take(), process.stdout.take()) else {
            let _ = process.kill();
            let _ = process.wait();
            return Err(io::Error::other("The sampler has no pipes."));
        };
        let (send, replies) = mpsc::channel();
        thread::spawn(move || {
            let mut status = [0u8];
            while output.read_exact(&mut status).is_ok() {
                let reply = if status[0] == OK {
                    let mut pixels = vec![0; FRAME];
                    if output.read_exact(&mut pixels).is_err() {
                        break;
                    }
                    Some(pixels)
                } else {
                    None
                };
                if send.send(reply).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            process,
            input,
            replies,
        })
    }

    /// `Err` means the child is gone or stuck and must be replaced.
    fn request(&mut self, id: u32, top_fraction: f64, timeout: Duration) -> Result<Reply, ()> {
        writeln!(self.input, "window {id} {top_fraction}")
            .and_then(|()| self.input.flush())
            .map_err(|_| ())?;
        self.replies.recv_timeout(timeout).map_err(|_| ())
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

#[derive(Default)]
struct Slot {
    running: Option<Running>,
    failed_at: Option<Instant>,
}

pub struct Sampler {
    command: fn() -> Command,
    timeout: Duration,
    slot: Mutex<Slot>,
}

impl Sampler {
    const fn new(command: fn() -> Command, timeout: Duration) -> Self {
        Self {
            command,
            timeout,
            slot: Mutex::new(Slot {
                running: None,
                failed_at: None,
            }),
        }
    }

    /// Start the child if it is not running, so the first sample is not slow.
    pub fn start(&self) {
        let mut slot = self.slot.lock().expect("sampler");
        if let Some(running) = slot.running.as_mut() {
            if matches!(running.process.try_wait(), Ok(None)) {
                return;
            }
            slot.running = None;
        }
        self.ensure_running(&mut slot);
    }

    pub fn stop(&self) {
        self.slot.lock().expect("sampler").running = None;
    }

    pub fn child_id(&self) -> Option<u32> {
        self.slot
            .lock()
            .expect("sampler")
            .running
            .as_ref()
            .map(|running| running.process.id())
    }

    /// Fill `out` with the window's pixels. A dead or stuck child is replaced
    /// once per call. If the replacement fails too, the next try waits a second.
    pub fn sample(&self, id: u32, top_fraction: f64, out: &mut [u8]) -> bool {
        if out.len() != FRAME {
            return false;
        }
        let mut slot = self.slot.lock().expect("sampler");
        for _ in 0..2 {
            if !self.ensure_running(&mut slot) {
                return false;
            }
            let Some(running) = slot.running.as_mut() else {
                return false;
            };
            match running.request(id, top_fraction, self.timeout) {
                Ok(Some(pixels)) => {
                    out.copy_from_slice(&pixels);
                    slot.failed_at = None;
                    return true;
                }
                Ok(None) => {
                    slot.failed_at = None;
                    return false;
                }
                Err(()) => {
                    eprintln!("chalk-helper: sampler_restarting");
                    slot.running = None;
                }
            }
        }
        slot.failed_at = Some(Instant::now());
        false
    }

    fn ensure_running(&self, slot: &mut Slot) -> bool {
        if slot.running.is_some() {
            return true;
        }
        if slot
            .failed_at
            .is_some_and(|at| at.elapsed() < RESPAWN_AFTER_FAILURE)
        {
            return false;
        }
        match Running::start(&mut (self.command)()) {
            Ok(running) => {
                slot.running = Some(running);
                true
            }
            Err(error) => {
                eprintln!("chalk-helper: sampler_unavailable {error}");
                slot.failed_at = Some(Instant::now());
                false
            }
        }
    }
}

fn helper_sampler() -> Command {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut command = Command::new(exe);
    command.arg(FLAG);
    command
}

pub fn shared() -> &'static Sampler {
    static SHARED: OnceLock<Sampler> = OnceLock::new();
    SHARED.get_or_init(|| Sampler::new(helper_sampler, REPLY_TIMEOUT))
}

unsafe extern "C" {
    fn chalk_run_window_sampler(serve: extern "C" fn() -> i32) -> !;
}

pub fn run_child() -> ! {
    // main calls this before Tauri starts; the bridge keeps the main queue live.
    unsafe { chalk_run_window_sampler(serve_requests) }
}

/// The child's side: answer requests until Helper closes the pipe.
extern "C" fn serve_requests() -> i32 {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut line = String::new();
    let mut pixels = vec![0; FRAME];
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => return 0,
            Ok(_) => {}
        }
        let captured = request(&line).is_some_and(|(id, top_fraction)| {
            window_follow::capture_in_process(id, top_fraction, &mut pixels)
        });
        let written = if captured {
            output
                .write_all(&[OK])
                .and_then(|()| output.write_all(&pixels))
        } else {
            output.write_all(&[FAILED])
        };
        if written.and_then(|()| output.flush()).is_err() {
            return 1;
        }
    }
}

fn request(line: &str) -> Option<(u32, f64)> {
    let mut words = line.split_ascii_whitespace();
    if words.next()? != "window" {
        return None;
    }
    let id = words.next()?.parse().ok()?;
    let top_fraction = words.next()?.parse().ok()?;
    ((0.0..=0.2).contains(&top_fraction) && words.next().is_none()).then_some((id, top_fraction))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUICK: Duration = Duration::from_millis(300);

    /// A shell sampler that answers every request with a frame of zeros, so
    /// the protocol is tested without Screen Recording.
    fn frames() -> Command {
        shell("while read request; do printf '\\001'; head -c 20736 /dev/zero; done")
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    fn sampler(command: fn() -> Command) -> Sampler {
        Sampler::new(command, QUICK)
    }

    #[test]
    fn a_frame_is_the_size_the_landmark_match_reads() {
        assert_eq!(FRAME, 72 * 72 * 4);
        assert_eq!(FRAME, 20736);
    }

    #[test]
    fn one_child_answers_many_requests() {
        let sampler = sampler(frames);
        let mut pixels = vec![9; FRAME];
        assert!(sampler.sample(7, 0.0, &mut pixels));
        let child = sampler.child_id().unwrap();
        assert!(pixels.iter().all(|&byte| byte == 0));
        assert!(sampler.sample(7, 0.0, &mut pixels));
        assert_eq!(sampler.child_id(), Some(child));
    }

    #[test]
    fn the_sampler_receives_the_verified_title_bar_crop() {
        fn cropped() -> Command {
            shell("while read request; do if [ \"$request\" = 'window 7 0.125' ]; then printf '\\001'; head -c 20736 /dev/zero; else printf '\\000'; fi; done")
        }
        let mut pixels = vec![0; FRAME];
        assert!(sampler(cropped).sample(7, 0.125, &mut pixels));
        assert_eq!(request("window 7 0.125\n"), Some((7, 0.125)));
        assert!(request("window 7 NaN").is_none());
        assert!(request("window 7 0.3").is_none());
    }

    #[test]
    fn a_failed_capture_is_not_a_dead_child() {
        fn failing() -> Command {
            shell("while read request; do printf '\\000'; done")
        }
        let sampler = sampler(failing);
        let mut pixels = vec![0; FRAME];
        assert!(!sampler.sample(7, 0.0, &mut pixels));
        let child = sampler.child_id().unwrap();
        assert!(!sampler.sample(7, 0.0, &mut pixels));
        assert_eq!(sampler.child_id(), Some(child));
    }

    #[test]
    fn a_child_that_dies_is_replaced_and_the_request_still_succeeds() {
        let sampler = sampler(frames);
        let mut pixels = vec![0; FRAME];
        assert!(sampler.sample(7, 0.0, &mut pixels));
        let first = sampler.child_id().unwrap();
        kill(first);
        assert!(sampler.sample(7, 0.0, &mut pixels));
        assert_ne!(sampler.child_id(), Some(first));
    }

    #[test]
    fn a_stuck_child_is_killed_and_replaced() {
        fn stuck_then_fine() -> Command {
            // The first child hangs on its first request; later ones answer.
            let marker = std::env::temp_dir().join(format!("chalk-stuck-{}", std::process::id()));
            shell(&format!(
                "if [ ! -e '{m}' ]; then touch '{m}'; read request; exec sleep 30; fi; \
                 while read request; do printf '\\001'; head -c 20736 /dev/zero; done",
                m = marker.display()
            ))
        }
        let sampler = sampler(stuck_then_fine);
        let mut pixels = vec![0; FRAME];
        let started = Instant::now();
        assert!(sampler.sample(7, 0.0, &mut pixels));
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_file(
            std::env::temp_dir().join(format!("chalk-stuck-{}", std::process::id())),
        );
    }

    #[test]
    fn a_child_that_keeps_dying_gives_up_and_pauses_before_the_next_try() {
        fn dying() -> Command {
            shell("read request; exit 1")
        }
        let sampler = sampler(dying);
        let mut pixels = vec![0; FRAME];
        assert!(!sampler.sample(7, 0.0, &mut pixels));
        assert_eq!(sampler.child_id(), None);
        // Inside the pause nothing is spawned, so there is no child to see.
        assert!(!sampler.sample(7, 0.0, &mut pixels));
        assert_eq!(sampler.child_id(), None);
        assert!(sampler.slot.lock().unwrap().failed_at.is_some());
    }

    #[test]
    fn a_child_that_cannot_start_is_reported_as_unavailable() {
        fn missing() -> Command {
            Command::new("/nonexistent/chalk-sampler")
        }
        let sampler = sampler(missing);
        let mut pixels = vec![0; FRAME];
        assert!(!sampler.sample(7, 0.0, &mut pixels));
        assert_eq!(sampler.child_id(), None);
    }

    #[test]
    fn stopping_ends_the_child_and_the_next_sample_starts_a_new_one() {
        let sampler = sampler(frames);
        let mut pixels = vec![0; FRAME];
        assert!(sampler.sample(7, 0.0, &mut pixels));
        let first = sampler.child_id().unwrap();
        sampler.stop();
        assert_eq!(sampler.child_id(), None);
        assert!(!alive(first));
        assert!(sampler.sample(7, 0.0, &mut pixels));
        assert_ne!(sampler.child_id(), Some(first));
    }

    #[test]
    fn a_buffer_of_the_wrong_size_is_refused_without_starting_a_child() {
        let sampler = sampler(frames);
        assert!(!sampler.sample(7, 0.0, &mut [0; 8]));
        assert_eq!(sampler.child_id(), None);
    }

    fn kill(pid: u32) {
        Command::new("/bin/kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap();
        for _ in 0..100 {
            if !alive(pid) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn alive(pid: u32) -> bool {
        Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|output| {
                let stat = String::from_utf8_lossy(&output.stdout);
                !stat.trim().is_empty() && !stat.trim().starts_with('Z')
            })
            .unwrap_or(false)
    }
}
