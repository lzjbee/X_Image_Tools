# X Image Tools

X（Twitter）图片查看增强工具集。

## twitter-image-zoom-enhancer

一个油猴（Tampermonkey）脚本，在 X/Twitter 桌面端图片详情页（`/status/.../photo/N`）中为图片提供缩放、拖拽和重置功能。

### 功能

- **Ctrl + 鼠标滚轮**：以鼠标位置为中心缩放图片
- **左键拖拽**：非 100% 时按住左键拖拽平移图片
- **R 键**：一键回到 100% 原始比例
- **双击图片**：回到 100%
- **左下角百分比指示器**：缩放时显示当前比例（如 150%），100% 时自动隐藏
- **多图切换**：不影响 X 原生箭头切换，100% 时完全穿透点击

### 适用场景

电脑端浏览 X 时，移动端发布的长截图、聊天记录截图等内容在图片详情页中无法放大，阅读困难。此脚本可直接在图片详情页内缩放查看，无需新标签页打开。

### 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `scripts/twitter-image-zoom-enhancer.user.js`
3. 复制全部内容，在 Tampermonkey 中新建脚本并粘贴
4. 保存并启用

### 生效页面

- `https://x.com/*/status/*/photo/*`
- `https://twitter.com/*/status/*/photo/*`

时间线和推文详情页不会触发，仅在图片查看页生效。

### 操作说明

| 操作 | 效果 |
|---|---|
| `Ctrl + 鼠标滚轮` | 缩放图片（50% – 800%） |
| 左键拖拽（非 100% 时） | 平移图片 |
| `R` | 重置到 100% |
| 双击图片（非 100% 时） | 重置到 100% |
| `Esc` | 隐藏百分比指示器 |
| ← → 箭头 | X 原生切图（不受影响） |

### 项目结构

```text
X_Image_Tools/
├── README.md
├── assets/            # 截图和示例资源
├── docs/              # 方案讨论和过程文档
└── scripts/           # 油猴脚本
    └── twitter-image-zoom-enhancer.user.js
```
