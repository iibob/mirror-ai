# Mirror Ai

将 VSCode 代码与 Gemini 网页版连接，实现 AI 辅助编程。

<img width="947" height="748" alt="image" src="https://github.com/user-attachments/assets/bd23b9c4-1062-4ecf-9a6d-89b0ad1e0cbc" />


## 目录结构

```
vscode-extension/   ← VSCode 插件（本地 WebSocket 服务端）
chrome-extension/   ← Chrome 插件（WebSocket 客户端 + Gemini 交互）
```


## 一、VSCode 插件

### 1. 安装依赖并编译

```bash
cd vscode-extension
npm install
npm run compile
```

### 2. 开发模式

打开 `vscode-extension` 文件夹后：
1. 按 **F5** → 自动编译并在新窗口启动扩展
2. 新窗口中按 `Ctrl+Shift+G` 打开面板
3. 修改 TypeScript 源码后会自动重编译，需在测试窗口按 `Ctrl+R` 重新加载窗口

### 3. 功能

| 操作       | 方法                                |
| -------- | --------------------------------- |
| 打开面板     | `Ctrl+Shift+G` / 命令面板搜索 Mirror Ai |
| 添加当前文件   | 面板按钮 / 编辑器右键菜单 / 命令面板             |
| 添加选中代码片段 | 面板按钮 / `Ctrl+Shift+A` / 右键菜单      |
| 添加其他文件   | 面板"其他文件"按钮                        |
| 取消已添加内容  | 点击标签上的 ✕                          |
| 插入代码到编辑器 | 回复气泡中代码块右上角"插入到编辑器"               |
| 新建对话     | 面板右上角"新建对话"                       |

### 4. 打包

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

### 5. 安装

打开 VSCode → 扩展面板 → 右上角 `···` → `从 VSIX 安装` → 选择 `.vsix` 文件


## 二、Chrome 插件

### 1. 安装

1. 打开 Chrome → 地址栏输入 `chrome://extensions/`
2. 右上角开启**开发者模式**
3. 点击**加载未打包的扩展程序**
4. 选择 `chrome-extension` 文件夹

### 2. 选择器更新

若 Gemini 网页改版后插件失效，需更新选择器：
1. 点击 Chrome 工具栏 Mirror Ai 图标
2. 展开"⚙ 高级配置（选择器）"
3. 打开 Chrome DevTools（F12）→ 在 Gemini 页面找到对应元素
4. 将新的 CSS 选择器填入对应字段（多个用逗号分隔）
5. 点击"保存选择器"

> 也可在 `chrome-extension/content.js` 顶部的 `SELECTORS` 对象里更新对应的选择器


## 三、使用流程

1. 打开 Chrome
2. 在 VSCode 中打开 Mirror Ai 插件
3. 顶部状态显示为 `Chrome 已连接` 即可进行对话

- 支持添加代码片段和文件
- 回复内容包含代码时，支持插入到编辑区的光标位置

> [!Warning]
> 对话尽量仅发送相关代码片段，完整文件可能会超出 Gemini 输入框字符上限


## 四、常见问题

**Q: VSCode 面板显示"未连接"**
- 在 Chrome 插件中点击"刷新状态"
- 检查端口 8765 是否被占用：`lsof -i :8765`

**Q: Gemini 不响应发送**
- 确认已打开 gemini.google.com 并登录
- Chrome 插件中 Gemini 状态应显示"已就绪"
- 若不就绪，刷新 Gemini 页面后再试
- 如果页面已改版，参考上方"选择器更新"步骤


## 五、隐私说明

- 所有通信通过 localhost WebSocket，数据不经过任何第三方服务器
- 代码内容仅发送到已登录的 Gemini 账户
- 插件不收集任何数据

