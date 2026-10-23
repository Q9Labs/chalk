if (typeof Animation !== "undefined") {
  const cancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function () {
    // happy-dom 21.0.4 omits the handled flag required when cancelling finished:
    // https://www.w3.org/TR/web-animations-1/#cancel-an-animation (step 1.3).
    void this.finished.catch(() => {});
    cancel.call(this);
  };
}
