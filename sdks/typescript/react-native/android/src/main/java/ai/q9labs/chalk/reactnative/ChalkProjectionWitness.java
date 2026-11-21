package ai.q9labs.chalk.reactnative;

import java.nio.ByteBuffer;

/** A spatial challenge, sampled before the local screen track is published. */
final class ChalkProjectionWitness {
  static final int CELLS = 8;
  private final int challenge;
  private final int width;
  private final int height;
  private final int cell;

  ChalkProjectionWitness(int challenge, int width, int height, int cell) {
    this.challenge = challenge;
    this.width = width;
    this.height = height;
    this.cell = cell;
  }

  int x(int anchor) { return (anchor == 0 ? width / 8 : 7 * width / 8) - CELLS * cell / 2; }
  int y(int anchor) { return anchor == 0 ? height / 8 : 7 * height / 8; }
  boolean white(int anchor, int column) { return (challenge & (1 << (anchor * CELLS + column))) != 0; }

  boolean matches(ByteBuffer luma, int stride, int rawWidth, int rawHeight, int rotation) {
    boolean sideways = rotation == 90 || rotation == 270;
    int presentedWidth = sideways ? rawHeight : rawWidth;
    int presentedHeight = sideways ? rawWidth : rawHeight;
    if (presentedWidth < 128 || presentedHeight < 128
        || Math.abs((double) presentedWidth / presentedHeight - (double) width / height) > 0.01) return false;

    for (int anchor = 0; anchor < 2; anchor++) {
      for (int column = 0; column < CELLS; column++) {
        int x = (int) ((x(anchor) + (column + 0.5) * cell) * presentedWidth / width);
        int y = (int) ((y(anchor) + 0.5 * cell) * presentedHeight / height);
        int rawX = switch (rotation) {
          case 90 -> y;
          case 180 -> rawWidth - 1 - x;
          case 270 -> rawWidth - 1 - y;
          default -> x;
        };
        int rawY = switch (rotation) {
          case 90 -> rawHeight - 1 - x;
          case 180 -> rawHeight - 1 - y;
          case 270 -> x;
          default -> y;
        };
        int value = Byte.toUnsignedInt(luma.get(rawY * stride + rawX));
        if (white(anchor, column) ? value < 190 : value > 65) return false;
      }
    }
    return true;
  }
}
