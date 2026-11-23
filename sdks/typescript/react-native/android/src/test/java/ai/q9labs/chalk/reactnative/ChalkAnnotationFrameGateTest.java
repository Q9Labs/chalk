package ai.q9labs.chalk.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ChalkAnnotationFrameGateTest {
  @Test public void withdrawalResumesPlainFramesThenReactivationResumesAnnotatedFrames() {
    ChalkAnnotationFrameGate gate = new ChalkAnnotationFrameGate();
    long firstInk = gate.update("annotated");
    gate.presented(firstInk);
    assertTrue(gate.forwardsFrames());

    gate.update("recovering");
    gate.presented(firstInk);
    assertFalse(gate.forwardsFrames());

    long cleared = gate.update("plain");
    assertEquals(ChalkAnnotationFrameGate.NO_TRANSITION, gate.update("plain"));
    assertFalse(gate.forwardsFrames());
    gate.presented(cleared);
    assertTrue(gate.forwardsFrames());

    long newInk = gate.update("annotated");
    gate.presented(cleared);
    assertFalse(gate.forwardsFrames());
    gate.presented(newInk);
    assertTrue(gate.forwardsFrames());
  }

  @Test public void withdrawalSupersedesAnInkPaintThatHasNotPresentedYet() {
    ChalkAnnotationFrameGate gate = new ChalkAnnotationFrameGate();
    assertEquals(ChalkAnnotationFrameGate.NO_TRANSITION, gate.update("plain"));
    assertTrue(gate.forwardsFrames());
    long oldInk = gate.update("annotated");
    long plain = gate.update("plain");
    gate.presented(oldInk);
    assertFalse(gate.forwardsFrames());
    gate.presented(plain);
    assertTrue(gate.forwardsFrames());
  }
}
