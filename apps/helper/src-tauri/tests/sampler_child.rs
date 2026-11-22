//! The real `chalk-helper --window-sampler` process, over its pipes.
#![cfg(target_os = "macos")]

use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[test]
fn the_child_answers_each_request_with_one_status_byte_and_exits_when_helper_closes_its_pipe() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_chalk-helper"))
        .arg("--window-sampler")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = child.stdout.take().unwrap();

    // Window 1 does not exist and the second line is not a request. Both fail
    // without ending the child, so each gets exactly one failure byte.
    input.write_all(b"window 1\nnonsense\n").unwrap();
    let mut replies = [9u8; 2];
    output.read_exact(&mut replies).unwrap();
    assert_eq!(replies, [0, 0]);

    drop(input);
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the child outlived its pipe"
        );
        thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success());
}
