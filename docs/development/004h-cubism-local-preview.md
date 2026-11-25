# 星咏 Cubism 桌宠预览

桌宠接受包含 `cubism` 变体和静态保底图的资源包。Cubism Web 预览通过官方 Framework 渲染模型，接入呼吸、眨眼、窗口内跟视、语音口型和睡眠状态。有对应导出动作组时，桌宠会播放动作组中的第一个动作。

## 导出星咏

从 Cubism Editor 导出模型到 `work/live2d/export/star-singer`，并保留相对目录结构。入口文件是 `star-singer.model3.json`，同目录包含 `.moc3`，贴图使用 8 位 RGBA PNG，单张边长最多 2048 像素。需要物理、姿势、动作或表情时，把对应文件一起导出并在 `.model3.json` 引用。模型参数可使用 `ParamAngleX/Y/Z`、`ParamEyeLOpen`、`ParamEyeROpen`、`ParamEyeBallX/Y`、`ParamBreath` 和 `ParamMouthOpenY`。眼睛和口型也支持模型配置中声明的 `EyeBlink` 与 `LipSync` 参数组。[Cubism 官方模型读取文档](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)

在 `work/pet` 执行以下 PowerShell 命令。输出版本目录应为新目录。

```powershell
node apps/desktop/scripts/prepare-cubism-pack.mjs '../live2d/export/star-singer/star-singer.model3.json' '../live2d/star-singer-1.2.0' 1.2.0
```

桌宠设置中的「导入资源包目录」可导入上面生成的版本目录。随后在星咏的资源包版本中选择 `1.2.0`。准备工具会复用星咏已有静态图和点击区域。模型导出图尺寸、裁切或站姿有差异时，请在 `manifest.json` 复核 `logicalSize`、`anchor` 和 `hitRegions`。

## 启用本机预览

浏览官方页面并按其协议获取 Cubism SDK for Web 5 R5，将其解压到本机。SDK 根目录应包含 `Core/live2dcubismcore.js`、`Framework/src` 和 `Framework/Shaders/WebGL`。[Cubism Web SDK 官方下载](https://www.live2d.com/en/sdk/download/web/)

在同一 PowerShell 会话中设置经核对的本地 Core 路径和散列，然后启动桌宠开发进程。

```powershell
$env:PET_DESKTOP_CUBISM_WEB_SDK = 'C:\Live2D\CubismSdkForWeb-5-r.5'
$env:PET_DESKTOP_CUBISM_CORE_SHA256 = (Get-FileHash (Join-Path $env:PET_DESKTOP_CUBISM_WEB_SDK 'Core/live2dcubismcore.js') -Algorithm SHA256).Hash
pnpm --filter @pet-desktop/desktop dev
```

开发服务器通过本地环回地址提供框架和着色器。资源包只含角色数据，MOC3 一致性由官方 Core 检查。正式打包版以及 Core、模型或 GPU 初始化失败时，桌宠采用资源包内可用的后备画面。[Cubism MOC3 一致性文档](https://docs.live2d.com/en/cubism-sdk-manual/moc3-consistency/)
