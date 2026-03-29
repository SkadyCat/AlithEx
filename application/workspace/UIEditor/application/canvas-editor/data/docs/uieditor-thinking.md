# UIEditor Thinking — 设计规范与思考指南

> 本文档记录在使用 Canvas Editor 进行 UMG/WBP 界面原型设计时，积累的思考规范和避坑指南。
> 每次发现新问题，应在此追加。

---

## 一、Widget 类型选择准则

**核心原则：用语义正确的控件，而不是"看起来像"的控件。**

| 你想要的效果 | ❌ 错误选择 | ✅ 正确选择 | 原因 |
|---|---|---|---|
| 进度条 / 血量条 / 重量条 | `Border` + 内部填充块 | `ProgressBar` | ProgressBar 本身就是进度条，有 Percent 属性；Border 只是视觉容器 |
| 带背景的文字区域 | `Border` + `TextBlock` | `Border`(容器) + `TextBlock`(子) | 这是正确的，但 Border 的语义是"带边框的容器"，不是"文字背景" |
| 输入框 | `Border` / `TextBlock` | `EditableText` / `EditableTextBox` | 用专门的输入控件，才有焦点、输入事件 |
| 图标/图片 | `Border` 设背景图 | `Image` | Image 控件专为图片设计，有 Brush 等属性 |
| 列表/网格展示 | 手动排列多个 Border | `TileView` / `ListView` | 数据驱动，EntryClass 定义单元样式 |
| 固定尺寸包装 | `CanvasPanel` + 手动设尺寸 | `SizeBox` | SizeBox 专门约束子控件尺寸 |
| 水平/垂直排列子控件 | `CanvasPanel` + 手动计算坐标 | `HorizontalBox` / `VerticalBox` | 自动布局，无需手动计算 |
| 分割线 / 分隔符 | `Border`（高度=2） | `Border`（可接受）或 专用分隔符图片 | Border 用作分隔线是可以的，但要明确命名（如 `Divider`）|

### 进度条问题（具体案例）

`bag2.session` 中的 `WeightBG (Border)` + `WeightFill` 组合，实际上是一个重量/负重进度条。

**应该这样做：**
- 使用 `ProgressBar` 控件代替 `Border + 填充块`
- 通过 `ProgressBar.Percent` 属性直接控制填充比例
- 可设置填充色（FillColorAndOpacity）和背景色

**为什么不能只用 Border？**
- Border 没有 Percent 属性，在蓝图中还需要手动计算宽度比例
- ProgressBar 原生支持动画过渡（从 0 到 1 的平滑变化）
- 代码更简洁：`WeightBar->SetPercent(CurrentWeight / MaxWeight)`

---

## 二、命名规范

### 节点命名格式

```
节点名 (控件类型)
```

- **节点名**：描述这个节点在界面中的业务含义，使用英文驼峰或下划线
- **控件类型**：括号内标注实际 Widget 类型，方便理解结构

**示例：**
```
WeightBar (ProgressBar)      ✅ 清晰
WeightBG (Border)            ⚠️ 名字说是"背景"，但实际做的是进度条功能
ItemGrid (TileView)          ✅ 清晰
InvPanel (CanvasPanel)       ✅ 清晰
Divider3 (Border)            ⚠️ 命名无具体含义，应改为 StatDivider (Border) 等
```

### 分隔线命名

分隔线应包含其所在区域信息：
```
HeaderDivider (Border)   ✅
ContentDivider (Border)  ✅
Divider1 / Divider2      ❌ 数字命名无语义
```

---

## 三、布局设计原则

### 3.1 避免意外重叠

**问题**：在 CanvasPanel 中，节点是绝对定位的，拖拽时容易产生部分重叠（既不完全重合，也不完全分开）。

**内置解决方案（已实现）**：
- 编辑器拖拽时会自动吸附到相邻节点的边缘（Edge Snap，阈值 12px）
- 数字输入直接在 right_info 面板精确设置 x/y/w/h

**设计规范**：
- 同级兄弟节点尽量做到：**完全分开** 或 **完全重合**（父子关系时），不要部分重叠
- 如果确实需要重叠（如遮罩、装饰层），用 `Overlay` 容器来明确表达层叠意图

### 3.2 坐标对齐

- 相邻节点的边缘应该精确对齐，不要有 1-2px 的误差
- 使用编辑器的 right_info 面板直接输入精确坐标
- 利用 Edge Snap（边缘吸附）功能辅助对齐

### 3.3 合理使用容器层级

```
BagWidget (CanvasPanel)          ← 根节点
├── TitleBar (Border)            ← 标题区
├── EquipPanel (CanvasPanel)     ← 装备栏区域
│   ├── HeadSlot (Border)        ← 头部槽位
│   └── ...
├── InvPanel (CanvasPanel)       ← 物品栏区域
│   └── ItemGrid (TileView)      ← 平铺视图
├── StatPanel (CanvasPanel)      ← 属性区域
│   ├── WeightBar (ProgressBar)  ← 负重进度条 ✅
│   └── ...
└── BottomBar (Border)           ← 底部操作栏
```

### 3.4 活用 HorizontalBox + VerticalBox 组织内容

**核心原则：用布局容器表达语义，而不是用 CanvasPanel + 手动绝对坐标。**

#### 模式一：标签+数值行 → HorizontalBox

```
hpRow (HorizontalBox)     ← 语义：这是一行"HP标签+HP数值"
├── hpLabel (TextBlock)   ← "HP"
└── hpValue (TextBlock)   ← "240 / 300"
```

✅ 好处：一眼可见这两个控件是同一行的逻辑组合，修改时可整体移动。

#### 模式二：标签行 + 进度条 → VerticalBox

```
hpGroup (VerticalBox)         ← 语义：HP 整体区域
├── hpRow (HorizontalBox)     ← 第一行：标签 + 数值
│   ├── hpLabel (TextBlock)
│   └── hpValue (TextBlock)
└── hpBar (ProgressBar)       ← 第二行：进度条
```

✅ 好处：整个 HP 显示区作为一个可独立移动、可整体删除的逻辑单元。

#### 模式三：背景图必须铺满父容器

**禁止使用奇怪的局部尺寸作为装饰背景。**

```
paperdollPanel (CanvasPanel) pos=(200,36) size=280x534
├── ❌ paperdollBody (Image) size=140x280   ← 奇怪的局部尺寸，看起来很难看
└── ✅ paperdollBody (Image) size=280x534   ← 铺满整个 paperdollPanel
```

- 如果设计上需要一个人物剪影/背景图，应铺满其所在的父容器
- 如果暂时不需要背景图，**直接删除**，不要保留奇怪的局部尺寸占位

#### 什么时候用 HBox/VBox，什么时候用 CanvasPanel？

| 场景 | 推荐容器 | 原因 |
|---|---|---|
| 需要精确绝对定位（如各自独立的 UI 区域） | `CanvasPanel` | 每个子控件独立定位 |
| 一排并列的内容（标签+数值、图标+文字） | `HorizontalBox` | 语义清晰，结构易读 |
| 垂直堆叠的内容（行1 + 行2 + 进度条） | `VerticalBox` | 语义清晰，整组易于移动 |
| 内容需要严格固定尺寸 | `SizeBox` | 明确约束子控件 |

> **注意**：AIWBPImporter 目前将 HBox/VBox 均转为 CanvasPanel，坐标仍用全局绝对坐标。  
> HBox/VBox 的价值在于**逻辑清晰**，而非运行时自动布局。

---

## 四、Session 设计规范

### .session 文件结构

- 使用树形结构，父子关系通过嵌套 `children` 表达
- `widgetType` 必须使用 elements.json 中定义的有效类型
- `isEntryClass: true` **只能** 设置在 TileView/ListView/TreeView 的直接 EntryClass 子节点上
- **⚠️ 禁止** 将 `isEntryClass: true` 设置在 session 根节点（如 BagWidget）上
- 根节点通常为 `CanvasPanel`，代表整个 WBP 的根 Canvas

### EntryClass 规范

- 每个 `TileView` / `ListView` / `TreeView` 必须有且仅有一个直接子节点，其 `label` 为 `"EntryClass"`
- EntryClass 内部定义单个列表项的视觉样式
- 不要在 EntryClass 之外给 TileView 添加非 EntryClass 的直接子节点

### isEntryClass 陷阱（重要！）

**症状**：Session 加载后，某个区域下的所有控件点击都会跳到同一个父节点，无法单独选中子控件。

**根本原因**：`getIsEntryClassAncestor()` 会向上遍历父链，一旦找到任何祖先节点带 `isEntryClass: true`，就将所有点击重定向到该祖先。如果根节点被误设置 `isEntryClass: true`，则整棵树的所有控件都无法单独选中。

**排查方法**：
```bash
# 直接搜索 session 文件中的 isEntryClass
grep -n "isEntryClass" data/docs/sessions/xxx.session
```

**修复方法**：将根节点或错误节点的 `isEntryClass` 改为 `false`。

**防护机制（已内置）**：`getIsEntryClassAncestor()` 只对有 `parentId` 的节点生效，session 根节点（`parentId` 为 null）即使有 `isEntryClass: true` 也不会锁定其子节点。

---

## 五、常见错误速查

| 错误现象 | 可能原因 | 解决方法 |
|---|---|---|
| Session 加载失败 | widgetType 不合法 | 检查所有节点的 widgetType，确保在 elements.json 中有定义 |
| TileView 无法预览网格 | 缺少 EntryClass 子节点 | 在 TileView 下添加一个 label='EntryClass' 的子节点 |
| 节点位置有交集 | 拖拽时未对齐 | 用 right_info 精确输入坐标，或使用 Edge Snap |
| 进度条无法在蓝图中控制 | 用 Border 模拟了进度条 | 改用 ProgressBar 控件 |
| 父节点删除子节点未删 | 旧版编辑器 Bug（已修复）| 升级后重新操作 |
| 所有子控件点击都跳到同一父节点 | 根节点 `isEntryClass: true` | 将该节点的 `isEntryClass` 改为 `false` |
| 按 P 无效果（预览模式不切换）| 主题 overlay 遮挡了透明容器 | 已修复：预览模式下不可见容器的 overlay 会自动隐藏 |

---

## 六、主题叠加系统（Theme Overlay）

主题系统通过纯 CSS 层叠效果为控件添加视觉风格（渐变、内阴影、纹理），**不污染 session JSON**。

### 工作原理

- 每个 `.box-item` DOM 元素内插入一个 `.theme-overlay` 子 div
- `pointer-events: none`，不影响交互
- `z-index: 0`（低于 resize-handle 的 z-index:5），不遮挡操作控件
- 主题数据保存在 `data/themes/{name}.json`，通过 `/api/theme?name=xxx` 接口访问

### 主题 JSON 格式

```json
{
  "types": {
    "Button": {
      "overlay": "linear-gradient(135deg, #3a2a1a 0%, #2a1a0a 100%)",
      "innerShadow": "inset 0 1px 3px rgba(0,0,0,0.5)",
      "opacity": 0.7
    }
  }
}
```

### 预览模式（P 键）注意事项

- 按 `P` 切换预览模式：隐藏不可见容器（CanvasPanel、HBox、VBox 等）的边框
- 预览模式中，不可见容器的 `.theme-overlay` 也会自动隐藏（`display: none`）
- 预览模式不影响有背景的控件（Button、Border、Image 等）的主题叠加层

---

## 六、更新日志

| 日期 | 问题 | 规范条目 |
|---|---|---|
| 2026-03-13 | WeightBG 用 Border 代替 ProgressBar | §一：Widget 类型选择 |
| 2026-03-13 | 节点位置有交集（部分重叠） | §三：布局设计原则 |
| 2026-03-13 | 节点名字在画布上显示混乱 | §二：命名规范 |
| 2026-03-14 | isEntryClass 设置在根节点导致所有子控件无法选中 | §四：Session 设计规范 — isEntryClass 陷阱 |
| 2026-03-14 | P键预览模式失效（主题 overlay 遮挡透明容器） | §五：常见错误速查，§六：主题系统 |
| 2026-03-14 | 主题叠加系统设计（不污染 JSON） | §六：主题叠加系统 |
| 2026-03-14 | skil_list 重叠：TypeBtnLabel 与 TypeBtn 同级 / EntryClass 子控件 parentId 指向 TileView | §三：布局设计原则 — 修正：标签应为按钮的子节点；EntryClass 子控件 parentId 必须为 EntryClass 的 id |
| 2026-03-24 | bag11 statPanel 使用平铺绝对坐标；paperdollBody 用奇怪的局部尺寸 | §三.3.4：活用 HBox+VBox 组织内容；背景图必须铺满父容器 |
