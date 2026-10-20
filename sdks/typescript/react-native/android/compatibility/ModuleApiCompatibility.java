import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.JarFile;
import java.util.regex.Pattern;
import java.util.zip.ZipFile;

/** Runs without Android initialization: RN reflects private and synthetic members too. */
public final class ModuleApiCompatibility {
  private static final Set<String> ROOTS = Set.of(
      "com/facebook/react/bridge/NativeModule", "com/facebook/react/uimanager/ViewManager");
  private static final Pattern TYPE = Pattern.compile("L([^;]+);");

  record Member(String name, String descriptor) {}
  record ClassInfo(String name, List<String> parents, List<Member> members) {}

  private static ClassInfo readClass(InputStream stream) throws IOException {
    try (var in = new DataInputStream(stream)) {
      if (in.readInt() != 0xcafebabe) throw new IOException("Not a class file");
      in.skipNBytes(4);
      Object[] pool = new Object[in.readUnsignedShort()];
      for (int i = 1; i < pool.length; i++) {
        switch (in.readUnsignedByte()) {
          case 1 -> pool[i] = in.readUTF();
          case 7 -> pool[i] = in.readUnsignedShort();
          case 3, 4, 9, 10, 11, 12, 17, 18 -> in.skipNBytes(4);
          case 5, 6 -> { in.skipNBytes(8); i++; }
          case 8, 16, 19, 20 -> in.skipNBytes(2);
          case 15 -> in.skipNBytes(3);
          default -> throw new IOException("Unknown constant pool entry");
        }
      }
      in.readUnsignedShort();
      String name = (String) pool[(int) pool[in.readUnsignedShort()]];
      var parents = new ArrayList<String>();
      int superclass = in.readUnsignedShort();
      if (superclass != 0) parents.add((String) pool[(int) pool[superclass]]);
      int interfaces = in.readUnsignedShort();
      for (int i = 0; i < interfaces; i++) {
        parents.add((String) pool[(int) pool[in.readUnsignedShort()]]);
      }
      var members = new ArrayList<Member>();
      // Both field_info and method_info have the same layout.
      for (int kind = 0; kind < 2; kind++) {
        int count = in.readUnsignedShort();
        for (int i = 0; i < count; i++) {
          in.readUnsignedShort();
          members.add(new Member((String) pool[in.readUnsignedShort()],
              (String) pool[in.readUnsignedShort()]));
          int attributes = in.readUnsignedShort();
          for (int j = 0; j < attributes; j++) {
            in.readUnsignedShort();
            in.skipNBytes(Integer.toUnsignedLong(in.readInt()));
          }
        }
      }
      return new ClassInfo(name, parents, members);
    }
  }

  private static boolean reflected(String name, ClassLoader classes, Map<String, Boolean> cache)
      throws IOException {
    if (ROOTS.contains(name)) return true;
    if (cache.containsKey(name)) return cache.get(name);
    var stream = classes.getResourceAsStream(name + ".class");
    if (stream == null) throw new IOException("Missing hierarchy class: " + name);
    var info = readClass(stream);
    for (String parent : info.parents()) {
      if (reflected(parent, classes, cache)) {
        cache.put(name, true);
        return true;
      }
    }
    cache.put(name, false);
    return false;
  }

  private static Set<String> platformTypes(Path jar) throws IOException {
    try (var zip = new JarFile(jar.toFile())) {
      var types = new HashSet<String>();
      zip.stream().filter(e -> e.getName().endsWith(".class"))
          .forEach(e -> types.add(e.getName().replaceFirst("\\.class$", "")));
      return types;
    }
  }

  private static List<String> check(ClassInfo info, ClassLoader runtime,
      Set<String> compileTypes, Set<String> supportedTypes) throws ClassNotFoundException {
    var errors = new ArrayList<String>();
    for (var member : info.members()) {
      var types = TYPE.matcher(member.descriptor());
      while (types.find()) {
        String type = types.group(1);
        // Also covers Java platform types that the host JDK could otherwise mask.
        if (compileTypes.contains(type) && !supportedTypes.contains(type)) {
          errors.add(member.name() + member.descriptor() + " missing " + type);
        }
      }
    }
    try {
      Class<?> module = Class.forName(info.name().replace('/', '.'), false, runtime);
      try { module.getDeclaredMethods(); }
      catch (LinkageError e) { errors.add("getDeclaredMethods: " + e); }
      try { module.getDeclaredFields(); }
      catch (LinkageError e) { errors.add("getDeclaredFields: " + e); }
    } catch (LinkageError e) {
      errors.add("class loading: " + e);
    }
    return errors;
  }

  private static List<ClassInfo> classes(Path directory) throws IOException {
    try (var files = Files.walk(directory)) {
      var result = new ArrayList<ClassInfo>();
      for (Path file : files.filter(p -> p.toString().endsWith(".class")).sorted().toList()) {
        result.add(readClass(Files.newInputStream(file)));
      }
      return result;
    }
  }

  private static URLClassLoader loader(List<Path> paths) throws MalformedURLException {
    var urls = new ArrayList<URL>();
    for (Path path : paths) urls.add(path.toUri().toURL());
    return new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader());
  }

  public static void main(String[] args) throws Exception {
    // Gradle writes paths one per line, avoiding command-line length limits.
    List<Path> paths = Files.readAllLines(Path.of(args[0])).stream().map(Path::of).toList();
    Path compilePlatform = paths.get(0);
    Path fixtureDirectory = paths.get(1);
    List<Path> moduleDirectories = paths.subList(2, 4);
    var dependencies = new ArrayList<Path>();
    Path extracted = Path.of(args[1]);
    Files.createDirectories(extracted);
    for (Path path : paths.subList(4, paths.size())) {
      if (!path.toString().endsWith(".aar")) { dependencies.add(path); continue; }
      try (var aar = new ZipFile(path.toFile())) {
        for (var entry : aar.stream().filter(e -> e.getName().endsWith(".jar")).toList()) {
          Path jar = extracted.resolve(dependencies.size() + ".jar");
          try (var stream = aar.getInputStream(entry)) {
            Files.copy(stream, jar, StandardCopyOption.REPLACE_EXISTING);
          }
          dependencies.add(jar);
        }
      }
    }
    var ownClasses = new ArrayList<ClassInfo>();
    for (Path directory : moduleDirectories) {
      if (Files.isDirectory(directory)) ownClasses.addAll(classes(directory));
    }
    if (ownClasses.isEmpty()) throw new AssertionError("No compiled SDK classes");
    var classpath = new ArrayList<Path>(moduleDirectories);
    classpath.add(fixtureDirectory);
    classpath.addAll(dependencies);
    var hierarchyPath = new ArrayList<Path>(classpath);
    hierarchyPath.add(compilePlatform);
    Set<String> compileTypes = platformTypes(compilePlatform);
    try (var hierarchy = loader(hierarchyPath)) {
      var cache = new HashMap<String, Boolean>();
      var modules = new ArrayList<ClassInfo>();
      for (var info : ownClasses) {
        if (reflected(info.name(), hierarchy, cache)) modules.add(info);
      }
      if (modules.isEmpty()) throw new AssertionError("No React Native modules/view managers");
      var fixtures = classes(fixtureDirectory);
      var expected = Map.of(
          "OriginalListenerModule", "AudioManager$OnCommunicationDeviceChangedListener",
          "FactoryInferredModule", "AudioManager$OnCommunicationDeviceChangedListener",
          "ModeListenerViewManager", "AudioManager$OnModeChangedListener");
      int failures = 0;
      for (int index = 2; index < args.length; index++) {
        Path platform = Path.of(args[index]);
        Set<String> supportedTypes = platformTypes(platform);
        var runtimePath = new ArrayList<Path>();
        runtimePath.add(platform);
        runtimePath.addAll(classpath);
        try (var runtime = loader(runtimePath)) {
          for (var module : modules) {
            var errors = check(module, runtime, compileTypes, supportedTypes);
            for (String error : errors) System.err.println(platform + ": " + module.name() + ": " + error);
            if (!errors.isEmpty()) failures++;
          }
          int rejected = 0;
          for (var fixture : fixtures) {
            String simpleName = fixture.name().substring(fixture.name().lastIndexOf('/') + 1);
            if (!expected.containsKey(simpleName)) continue;
            if (!reflected(fixture.name(), hierarchy, cache)) {
              throw new AssertionError("Fixture is not a module/view manager: " + simpleName);
            }
            var errors = check(fixture, runtime, compileTypes, supportedTypes);
            String missing = expected.get(simpleName);
            if (errors.stream().noneMatch(e -> e.contains("missing android/media/" + missing))
                || errors.stream().noneMatch(e -> e.contains("getDeclaredMethods: java.lang.NoClassDefFoundError"))) {
              throw new AssertionError("Unsafe fixture escaped: " + simpleName + ": " + errors);
            }
            rejected++;
            System.out.println("EXPECTED FAIL " + platform.getParent().getFileName() + " " + simpleName + ": " + errors);
          }
          if (rejected != expected.size()) throw new AssertionError("Missing negative fixtures");
          System.out.println("Checked " + modules.size() + " SDK modules/view managers against " + platform);
        }
      }
      if (args.length < 3 || failures != 0) throw new AssertionError("Incompatible SDK classes: " + failures);
    }
  }
}
