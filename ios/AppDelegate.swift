//
//  AppDelegate.swift
//  BaoGao
//
//  纯代码启动（无 storyboard）：window + ViewController。
//  对照此前苹果 App（dice-cup-ios / img-compress-ios）同款范式。
//
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = ViewController()
        window?.makeKeyAndVisible()
        return true
    }
}
