# 我要报告 · iOS App（苹果版）

与安卓版「我要报告」功能完全对应的苹果 App。沿袭此前苹果 App（摇骰盅 / 图片压缩）的成熟范式：

- **纯代码 Swift（无 storyboard）** + **WKWebView 壳** + **JS↔原生桥**。
- 工程用 **XcodeGen**（`project.yml`）管理，不提交 `xcodeproj`，Windows 上也能改结构。
- **服务器驱动**：WKWebView 直接加载 `https://feng.cpolar.top/baogao/`（与安卓 `MainActivity.DEFAULT_URL` 一致）。
  Web 端改了不用重打 IPA。要换地址改 `ViewController.swift` 顶部的 `baseURL` 即可。

## 与安卓同款、且 Web 端零改动的桥接契约

Web 端 `report-app/assets/app.js` 只认 `window.BaoGaoNative` 两个方法，iOS 已 1:1 实现：

| 方法 | 行为 |
|------|------|
| `getInfo()` | 同步返回设备信息（`device_id` / `model` / `platform:"ios"` / `ios_version` …），供统计上报。 |
| `pickPhoto(kind)` | `kind` ∈ `camera`/`album`，调起原生 `UIImagePickerController`；选完图回传 `window.__onNativePhoto(dataUrl)`（同安卓回调）。 |

> iOS 的 WKWebView 没有「同步返回值」桥，故 `getInfo` 通过在页面开始即注入全局 `window.__nativeInfo`，再由 `getInfo()` 直接 `return` 它来实现同步；`pickPhoto` 走异步 `messageHandler`，结果与安卓一样经 `__onNativePhoto` 回调。

## 目录结构

```
report-app-ios/
├── project.yml                      # XcodeGen 工程定义（改这里 = 改工程）
├── _make_icon.py                    # 生成 1024 图标（红底白圈印章，与安卓同款）
└── ios/
    ├── AppDelegate.swift            # 纯代码启动入口
    ├── ViewController.swift         # WKWebView 壳 + BaoGaoNative 桥 + 相机/相册/定位
    ├── Info.plist                   # 由 xcodegen 依据 project.yml 重写（含隐私描述）
    ├── PrivacyInfo.xcprivacy        # 隐私清单（UserDefaults / 文件时间戳）
    └── Assets.xcassets/
        ├── AppIcon.appiconset/      # icon1024.png（已生成）
        └── LaunchBackground.colorset/  # 启动屏底色 = App 背景 #DDE3EA
```

## 在 Mac 上构建 / 装真机（本机 Windows 无法编译 IPA）

前置：一台 Mac + Xcode 15+、已装命令行工具；Apple 开发者账号（免费可真机调试，TestFlight/上架需付费）。

```bash
# 1) 安装 XcodeGen（只需一次）
brew install xcodegen

# 2) 进入工程目录，生成 Xcode 工程
cd report-app-ios
xcodegen generate          # 生成 BaoGao.xcodeproj

# 3) 用 Xcode 打开，配置签名
open BaoGao.xcodeproj
#   Signing & Capabilities → Team 选你的开发者账号
#   ⚠️ project.yml 里的 DEVELOPMENT_TEAM: YOUR_TEAM_ID 改成你的 Team ID（也可在 Xcode 里直接选）

# 4) 选真机设备 → ▶ Run（Cmd+R）装到 iPhone 调试
#    或：Product → Archive → 分发（TestFlight / Ad Hoc / App Store）
```

### 真机调试要点
- **相机 / 相册 / 定位** 首次使用会弹系统授权框（文案已在 `Info.plist` 写好），点允许即可。
- 若改了 `baseURL` 或桥接逻辑，重跑 `xcodegen generate` 再 Build。
- 想换图标文字：`ICON_TEXT=举报 python _make_icon.py`（需有 `C:/Windows/Fonts/msyhbd.ttc`；
  在 Mac 上把字体路径改成 Mac 上的中文字体，如 `/System/Library/Fonts/PingFang.ttc`）。

## 与安卓版的差异（已处理）
- iOS 没有 Flyme 那类破桥接问题，但 WKWebView 的 `<input type=file>` 仍不可靠（尤其相机），
  所以相机/相册统一走原生桥，和安卓绕开 `<input>` 的思路一致、Web 端同一份代码通用。
- 定位：WKWebView 的 Web 地理定位需原生放行，`ViewController` 已实现 `WKUIDelegate` 的
  `requestGeolocationPermissionFor*`（兼容 iOS 15/17+），用户拒绝时 Web 端会静默降级为无坐标，不影响提交。

## 已知边界
- 本工程**只交付源码与工程定义**，不在 Windows 上编译/出 IPA（需 Mac + Xcode）。
- 未接入 App Store 上架 / 资质审核，只提供本地构建与分发指引（同此前苹果 App 的约定）。
- 后台 `/admin` 仍仅本机访问（与安卓版一致的安全策略）。
