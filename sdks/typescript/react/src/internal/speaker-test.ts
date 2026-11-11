/** Plays a 0.4 s, 440 Hz tone through the chosen speaker, or the system output when none is chosen. */
export async function playSpeakerTestTone(speakerId?: string): Promise<void> {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const output = context.createMediaStreamDestination();
  const audio = new Audio();
  try {
    if (speakerId && audio.setSinkId) await audio.setSinkId(speakerId);
    audio.srcObject = output.stream;
    oscillator.connect(gain).connect(output);
    gain.gain.value = 0.15;
    oscillator.frequency.value = 440;
    oscillator.start();
    await audio.play();
    await new Promise<void>((resolve) => {
      oscillator.onended = () => resolve();
      oscillator.stop(context.currentTime + 0.4);
    });
  } finally {
    audio.pause();
    audio.srcObject = null;
    oscillator.disconnect();
    gain.disconnect();
    output.stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
