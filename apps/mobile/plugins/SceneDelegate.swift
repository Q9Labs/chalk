class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate {
    guard let delegate = UIApplication.shared.delegate as? AppDelegate else {
      fatalError("Chalk's scene requires its Expo app delegate")
    }
    return delegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let factory = appDelegate.reactNativeFactory else {
      fatalError("Chalk's React Native factory must exist before its scene connects")
    }

    // Keep the app-delegate window available to Expo modules and presentation helpers.
    let window = appDelegate.window ?? UIWindow(windowScene: windowScene)
    window.windowScene = windowScene
    self.window = window
    appDelegate.window = window

    if window.rootViewController == nil {
      // RN's getInitialURL reads launch options, before JS can receive URL events.
      var launchOptions = appDelegate.reactNativeLaunchOptions ?? [:]
      if let url = connectionOptions.urlContexts.first?.url {
        launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
      }
      if let activity = connectionOptions.userActivities.first(where: {
        $0.activityType == NSUserActivityTypeBrowsingWeb
      }) {
        launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
          "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
          "UIApplicationLaunchOptionsUserActivityKey": activity,
        ]
      }
      factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
      appDelegate.reactNativeLaunchOptions = nil
    } else {
      window.makeKeyAndVisible()
    }

    open(connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach(continueActivity)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(URLContexts)
  }

  private func open(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueActivity(userActivity)
  }

  private func continueActivity(_ activity: NSUserActivity) {
    _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }

  func scene(_ scene: UIScene, willContinueUserActivityWithType userActivityType: String) {
    _ = appDelegate.application(UIApplication.shared, willContinueUserActivityWithType: userActivityType)
  }

  func scene(_ scene: UIScene, didFailToContinueUserActivityWithType userActivityType: String, error: Error) {
    appDelegate.application(UIApplication.shared, didFailToContinueUserActivityWithType: userActivityType, error: error)
  }

  func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {
    appDelegate.application(UIApplication.shared, didUpdate: userActivity)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate.applicationDidEnterBackground(UIApplication.shared)
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    appDelegate.application(UIApplication.shared, performActionFor: shortcutItem, completionHandler: completionHandler)
  }
}
