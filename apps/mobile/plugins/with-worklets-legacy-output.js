// Reanimated 4.2 and expo-modules-core 55 link libworklets.so from AGP's pre-8 CMake output folder,
// which AGP 8.12 no longer fills, so a clean Android build fails with "libworklets.so missing".
// Expo fixed its side in expo/expo#43863 (SDK 56); drop this plugin once both consumers link via prefab.
const { withProjectBuildGradle } = require("expo/config-plugins");

const MARKER = "chalk: libworklets.so legacy output";

const GRADLE = `
// ${MARKER}
gradle.projectsEvaluated {
  def worklets = rootProject.findProject(":react-native-worklets")
  if (worklets == null) return
  def buildDir = worklets.layout.buildDirectory.get().asFile
  [Debug: "debug", RelWithDebInfo: "release"].each { cmakeType, legacyType ->
    def workletsBuilds = worklets.tasks.matching { it.name.startsWith("buildCMake\${cmakeType}") }
    workletsBuilds.configureEach { task ->
      task.doLast {
        worklets.fileTree("\${buildDir}/intermediates/cxx/\${cmakeType}").include("**/obj/*/libworklets.so").each { so ->
          // Delete first: the legacy file can share an inode with the AGP output, and copying over it truncates the source.
          def legacy = new File("\${buildDir}/intermediates/cmake/\${legacyType}/obj/\${so.parentFile.name}/libworklets.so")
          legacy.delete()
          worklets.copy { from so; into legacy.parentFile }
        }
      }
    }
    [":react-native-reanimated", ":expo-modules-core"].each { path ->
      rootProject.findProject(path)?.tasks?.matching { it.name.startsWith("buildCMake\${cmakeType}") }?.configureEach { it.dependsOn(workletsBuilds) }
    }
  }
}
`;

module.exports = function withWorkletsLegacyOutput(config) {
  return withProjectBuildGradle(config, (next) => {
    if (!next.modResults.contents.includes(MARKER)) next.modResults.contents += GRADLE;
    return next;
  });
};
