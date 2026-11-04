//
//  ViewController.swift
//  BaoGao
//
//  WKWebView 容器 + 与安卓同款 JSBridge 契约（Web 端零改动）：
//
//   · 原生 → 注入 window.BaoGaoNative：
//       - getInfo()        同步返回设备信息（device_id / model / platform …），
//                          与安卓 addJavascriptInterface 的 getInfo 同字段，供统计上报。
//       - pickPhoto(kind)  kind ∈ 'camera' | 'album'，触发原生选择器；
//                          选完图后回传 window.__onNativePhoto(dataUrl)（同安卓）。
//   · JS → 原生：window.webkit.messageHandlers.baoGaoPick.postMessage({kind})
//
//  ⚠️ 与安卓的差异点（iOS 特有）：
//     iOS 的 WKWebView 没有「同步返回值」的桥，故 getInfo 通过在 atDocumentStart
//     注入一个全局 window.__nativeInfo，再由 getInfo() 直接 return 它来实现同步读取；
//     pickPhoto 走异步 messageHandler（与安卓一致，结果经 __onNativePhoto 回调）。
//     WKWebView 的 <input type=file> 在 iOS 上不可靠（尤其相机），故相机/相册一律走原生桥，
//     与安卓绕开 Flyme 破桥接的思路一致。
//
//  ⚠️ 本地化加载（2026-11-04 改为 offline-first）：
//     前端资源（index.html / assets / vendor / manifest）随 App 包安装（ios/web/），
//     用 WKWebView.loadFileURL 直接读本地文件 —— 后端 8780 在不在，界面都能开。
//     只有「同步」才走网：app.js 在 file:// 协议下把 API 直连公网 feng.cpolar.top/baogao
//     （后端 CORS 已设 *，file:// 的 null origin 也可过），后端不在时 fetch 失败，
//     前端 OUTBOX 接管（本地暂存、联网自动补传），UI 无感。与安卓 file:///android_asset 同款。
//
import UIKit
import WebKit
import CoreLocation

final class ViewController: UIViewController,
                            WKScriptMessageHandler,
                            WKUIDelegate,
                            UIImagePickerControllerDelegate,
                            UINavigationControllerDelegate,
                            CLLocationManagerDelegate {

    // 本地化加载：前端资源随包安装（ios/web/），用 loadFileURL 直接读本地文件，
    // 界面永远离线可开；API 由 app.js 在 file:// 协议下直连公网 feng.cpolar.top/baogao，
    // 后端不在时 fetch 失败、前端 OUTBOX 接管，UI 无感（与安卓 file:///android_asset 同款）。

    private var webView: WKWebView!
    private var picker: UIImagePickerController?
    private let locationManager = CLLocationManager()

    // 设备 ID：首次生成后存 UserDefaults，跨启动稳定（与安卓 device_id 同用途）。
    private let deviceId: String = {
        let key = "baogao_device_id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let new = UUID().uuidString
        UserDefaults.standard.set(new, forKey: key)
        return new
    }()

    // MARK: - 生命周期
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        setupWebView()
    }

    private func setupWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 保持网页里的 blob / FileReader 行为与桌面一致
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false

        // 注入 BaoGaoNative 桥（atDocumentStart，确保 Web 端 nativeInfo() 调用前已就绪）
        let info = """
        (function () {
          window.__nativeInfo = {
            device_id: "\(deviceId)",
            fingerprint: "\(deviceId)",
            app_version: "1.0",
            model: "\(deviceModel())",
            manufacturer: "Apple",
            platform: "ios",
            ios_version: "\(UIDevice.current.systemVersion)"
          };
          window.BaoGaoNative = {
            getInfo: function () { return window.__nativeInfo; },
            pickPhoto: function (kind) {
              try { window.webkit.messageHandlers.baoGaoPick.postMessage({ kind: String(kind) }); } catch (e) {}
            }
          };
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: info, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "baoGaoPick")

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        // 不让系统自动加安全区 inset：页面用 CSS env(safe-area-inset-*) 自己排
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.uiDelegate = self            // 接管 geolocation 权限请求
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // 本地化加载：前端资源随包安装（ios/web/），用 loadFileURL 直接读本地文件，
        // 界面离线可开；API 由 app.js 在 file:// 协议下直连公网，后端不在时 OUTBOX 接管。
        loadLocalWeb()
    }

    // MARK: - JS → 原生：打开相机 / 相册
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "baoGaoPick",
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }
        openPicker(kind: kind)
    }

    private func openPicker(kind: String) {
        // 相机可用且请求相机时走相机；否则（或模拟器无相机）退回相册
        let useCamera = (kind == "camera") && UIImagePickerController.isSourceTypeAvailable(.camera)
        let source: UIImagePickerController.SourceType = useCamera ? .camera : .photoLibrary

        let pc = UIImagePickerController()
        pc.sourceType = source
        pc.delegate = self
        pc.allowsEditing = false
        picker = pc
        DispatchQueue.main.async { [weak self] in
            self?.present(pc, animated: true)
        }
    }

    // MARK: - 原生 → JS：选完图回传 dataURL（同安卓 window.__onNativePhoto）
    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        self.picker = nil
        guard let img = info[.originalImage] as? UIImage else { deliver(nil); return }
        // 与安卓 compress(1600,0.86) 对齐：先缩放到长边 1600，再 JPEG 0.86
        let resized = resize(image: img, maxDim: 1600)
        guard let data = resized?.jpegData(compressionQuality: 0.86) else { deliver(nil); return }
        let b64 = data.base64EncodedString()
        deliver("data:image/jpeg;base64," + b64)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        self.picker = nil
        deliver(nil)
    }

    private func deliver(_ dataUrl: String?) {
        let js = dataUrl == nil
            ? "window.__onNativePhoto(null)"
            : "window.__onNativePhoto('" + dataUrl! + "')"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - 图片缩放（长边不超过 maxDim）
    private func resize(image: UIImage, maxDim: CGFloat) -> UIImage? {
        let w = image.size.width, h = image.size.height
        let longest = max(w, h)
        guard longest > maxDim else { return image }
        let scale = maxDim / longest
        let newSize = CGSize(width: w * scale, height: h * scale)
        UIGraphicsBeginImageContextWithOptions(newSize, false, 1.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let out = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()
        return out
    }

    // MARK: - 本地化加载：WKWebView 直读包内 ios/web/ 前端（无需本地 HTTP server）
    //   后端 8780 在不在，界面都能开；API 由 app.js 在 file:// 下直连公网，离线仅同步失败。
    private func loadLocalWeb() {
        guard let webDir = Bundle.main.url(forResource: "web", withExtension: nil) else {
            // 兜底：万一 web 没进包，退回远程（此时后端必须在才能开界面）
            if let url = URL(string: "https://feng.cpolar.top/baogao/") {
                webView.load(URLRequest(url: url))
            }
            return
        }
        let indexURL = webDir.appendingPathComponent("index.html")
        // allowingReadAccessTo: 放开整个 web/ 目录，使 assets/ vendor/ manifest 等子资源可读
        webView.loadFileURL(indexURL, allowingReadAccessTo: webDir)
    }

    // MARK: - 定位权限（Web 端 navigator.geolocation 在 WKWebView 需原生放行）
    func webView(_ webView: WKWebView,
                 requestGeolocationPermissionFor frame: WKFrameInfo,
                 decisionHandler: @escaping (Bool) -> Void) {
        requestLocationPermission(decisionHandler)
    }

    @available(iOS 17.0, *)
    func webView(_ webView: WKWebView,
                 requestGeolocationPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 decisionHandler: @escaping (Bool) -> Void) {
        requestLocationPermission(decisionHandler)
    }

    private func requestLocationPermission(_ decisionHandler: @escaping (Bool) -> Void) {
        switch locationManager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            decisionHandler(true)
        case .notDetermined:
            // 返回 true 让系统弹出定位授权框；用户拒绝则在 Web 端静默降级为 coords=null
            locationManager.requestWhenInUseAuthorization()
            decisionHandler(true)
        default:
            decisionHandler(false)
        }
    }

    // MARK: - 设备型号（如 iPhone15,2）
    private func deviceModel() -> String {
        var sysinfo = utsname()
        uname(&sysinfo)
        return withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 256) {
                String(cString: $0)
            }
        }
    }

    // MARK: - 布局兜底：铺满整屏（含安全区）
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        webView?.frame = view.bounds
    }
}
