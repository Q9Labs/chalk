import { registerRootComponent } from "expo";
import App from "./App";

const Fixture = __DEV__ && process.env.EXPO_PUBLIC_CHALK_ANNOTATION_FIXTURE === "1"
  ? (require("./e2e/AnnotationFixture") as typeof import("./e2e/AnnotationFixture")).AnnotationFixtureApp
  : null;

registerRootComponent(Fixture ?? App);
