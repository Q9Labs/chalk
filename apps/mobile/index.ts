import { registerRootComponent } from "expo";

const Root = __DEV__ && process.env.EXPO_PUBLIC_CHALK_ANNOTATION_FIXTURE === "1" ? (require("./e2e/AnnotationFixture") as typeof import("./e2e/AnnotationFixture")).AnnotationFixtureApp : (require("./App") as typeof import("./App")).default;

registerRootComponent(Root);
