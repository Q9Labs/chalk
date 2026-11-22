package ai.q9labs.chalk.reactnative;

/** Permit capture only after the corresponding overlay has been painted. */
final class ChalkAnnotationFrameGate {
  static final long NO_TRANSITION = 0;

  private volatile boolean holding;
  private boolean annotated;
  private boolean paintPending;
  private long revision;

  // The UI thread owns transitions. The capture thread only reads holding.
  long update(String mode) {
    if ("recovering".equals(mode)) {
      holding = annotated || holding;
      revision++;
      paintPending = false;
      return NO_TRANSITION;
    }
    boolean nextAnnotated = "annotated".equals(mode);
    if (annotated == nextAnnotated && (!holding || paintPending)) return NO_TRANSITION;
    annotated = nextAnnotated;
    holding = true;
    paintPending = true;
    return ++revision;
  }

  boolean isCurrent(long paint) {
    return paintPending && revision == paint;
  }

  void presented(long paint) {
    if (!isCurrent(paint)) return;
    paintPending = false;
    holding = false;
  }

  boolean forwardsFrames() {
    return !holding;
  }
}
