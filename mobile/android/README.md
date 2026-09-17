# Armada Remote（Android）

落地默认：**Kotlin + Jetpack Compose**，功能对齐现网 iOS（`mobile/ios/ArmadaRemote`）。规格不锁技术栈。

## 构建

需要 JDK 17 和 Android SDK（`ANDROID_HOME` 指向 SDK，且已装 `platform-tools`）。

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17   # 或本机 JDK 17
export ANDROID_HOME=$HOME/Library/Android/sdk
cd mobile/android
./gradlew :core:test          # 不需要 SDK：邀请 / 文案 / 看板规则
./gradlew :app:assembleDebug  # 需要 SDK：debug APK
```

模拟器连本机中转：绑定 `armada-relay://op?relay=http://10.0.2.2:8780&fleet=…&token=…`。

## 推送

锁屏走中转 FCM（`platform=fcm`）。没有 `google-services.json` / 中转未配 `RELAY_FCM_SERVICE_ACCOUNT_PATH` 时前台 SSE 仍可用，与 iOS 无 `.p8` 相同。

把 Firebase 的 `google-services.json` 放到 `app/`（**不要提交**）。中转机：

```bash
RELAY_FCM_SERVICE_ACCOUNT_PATH=/path/to/sa.json
# 可选 RELAY_FCM_PROJECT_ID=…
```

## 不要做

不要把 hub `:7380` 映射到公网。隐藏列表只允许 `view=hidden`，不要发 `archived=1`。
