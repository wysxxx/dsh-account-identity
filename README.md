# 账号身份 · Account Identity

为 DeepSeek Harness 侧边栏设置自己的显示名称与头像。支持拖动、缩放和预览头像选区，随时暂停以恢复宿主与主题原有的显示规则。

这个插件只改变 Harness 内的显示，不修改 DeepSeek 账号资料。

## 使用

1. 在 Harness 的插件管理中，从本仓库安装，或安装 [Releases](https://github.com/wysxxx/dsh-account-identity/releases) 中的 `.tgz` 包。
2. 按 Harness 提示重启，进入 **设置 → 账号身份**。
3. 填写显示名称，或选择图片。拖动图片、调整缩放，确认圆框中的预览后点击 **使用此头像**。

留空名称或暂停自定义后，恢复宿主与当前主题原有的显示规则；Claude Style 会条件恢复同步前的 `username`。移除图片会沿用账号原始头像，已保存的其他自定义内容仍然保留。

头像编辑支持鼠标拖动和方向键；按住 Shift 可加快移动，Tab 可切换控件，Escape 可取消。取消不会替换已保存的头像。

## 界面演示

以下是在实际 Harness 中操作插件的截图；账号名称、头像与数据均为合成演示。猫头像由 ImageGen 生成，截图中的界面由实际插件渲染。

![拖动和缩放头像选区](https://raw.githubusercontent.com/wysxxx/dsh-account-identity/main/docs/assets/crop.png)

![设置显示名称与头像](https://raw.githubusercontent.com/wysxxx/dsh-account-identity/main/docs/assets/settings.png)

## 头像处理与数据

- 图片在本地解码、裁切，不上传原图。保存在 Harness 当前 profile 配置中的是 **128 × 128 PNG**。
- 输入文件最多 **8 MiB**；解码后最多 **40 × 1024 × 1024 像素**。长边超过 4096 像素时先缩小，编辑缩放为 1–4 倍。
- 预览按原生头像的圆形容器显示；保存的图片为正方形，便于宿主或主题自行处理圆角。动画图片按浏览器解码出的单帧处理，不保留动画。
- 名称、头像与可逆的 Claude 主题名称恢复记录都保存在当前 profile 中。若你同步或公开配置文件，这些内容也可能被同步或公开。
- 插件使用 Harness 的账号服务显示登录状态与原始头像。原始账号头像仍可能由 Harness 从其原有地址加载；插件不提供独立的遥测或图片上传服务。

## 兼容范围

已针对 **DeepSeek Harness 0.2.1-rc.3 / Claude Style 0.19.5** 验证。Claude Style 的 footer 展开与收纳两种方式均在验证范围内。

| 界面 | 支持方式与边界 |
| --- | --- |
| 原生 Harness | 使用公共账号服务、设置插槽和颜色变量。 |
| Claude Style | 限定于本插件账号行的主题适配，保留该主题注入的费用卡片。 |
| 其他主题 | 公共插槽与颜色变量可复用；若主题替换账号入口、覆写名称或依赖特定 DOM，需要另外验证，尚未宣称兼容。 |

费用卡片由你安装的费用插件与主题提供；本插件不计算费用，也不读取费用服务的凭据。

插件启用且至少设置了一个自定义字段时，会提供自己的账号入口、设置入口和退出登录确认。**官方赠金通知栈与意见反馈入口尚未覆盖**。没有自定义内容、暂停自定义显示或未登录官方账号时，账号入口由 Harness 提供。

Claude Style 会独立覆写账号名称，因此自定义名称启用期间，插件会临时同步该主题的 `username`；这也可能影响主题中其他显示名称的位置。暂停或重置时，只恢复仍由本插件持有的值。仅修改头像不会触发名称同步。

**停用或卸载前，先在“账号身份”页暂停并确认原有显示规则恢复。** 直接结束进程不能保证异步的主题名称恢复完成。未来宿主或主题升级后，应重新验证菜单、费用卡片、头像与缩放。

## 开发

运行环境提供 React 与 `@deepseek-ai/schemastery`。本仓库提供可直接安装的 JavaScript，无需构建步骤。

```sh
npm test
npm pack
```

客户端仅从 Harness 的浏览器基线加载 React，不在运行时加载 Harness Client 包，不使用宿主哈希类名或私有弹窗栈。菜单和头像编辑器分别通过 `shell.overlay` 挂载；裁切框使用浏览器原生 `dialog` 顶层，节点由插件自己的 React 生命周期管理。

自动回归检查姓名同步与恢复、异步竞态、资源释放、裁切坐标、导出尺寸与依赖边界。真实的菜单、键盘、缩放和第三方费用卡片仍需在实际 Harness 中验证。

遇到问题请附 Harness / 主题版本、主题名称、复现步骤及去除个人信息的截图，到 [Issues](https://github.com/wysxxx/dsh-account-identity/issues) 反馈。

## English

Customize the name and avatar displayed in the DeepSeek Harness sidebar without changing your DeepSeek account profile. The local avatar editor supports pan, zoom, keyboard controls and a circular preview; it stores a 128 × 128 square PNG in your Harness profile.

Install this repository or a release `.tgz` through Harness plugin management, restart when prompted, then open **Settings → Account identity**. Pause the override before disabling or uninstalling the plugin so its temporary Claude Style name can be restored.

Tested with Harness 0.2.1-rc.3 and Claude Style 0.19.5. Other themes are unverified. Cost cards remain supplied by their original plugin and theme. The replacement account menu does not yet include the official bonus-notification stack or feedback entry. See the compatibility and data notes above for details.

## License

[MIT](LICENSE). Adapted upstream code and its license are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
