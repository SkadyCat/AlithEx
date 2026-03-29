# UIEditor Thinking — Canvas Editor 设计规范

> 本规范记录在使用 Canvas Editor 进行 UMG/WBP UI 布局设计时，
> 应当遵守的控件选型、坐标、命名与层级原则，防止反模式出现。

---

## 一、控件选型规范

### ✅ 正确映射

| 功能场景 | 应使用的控件类型 | ❌ 错误用法示例 |
|---|---|---|
| 进度条（血量/重量/经验） | **ProgressBar** | 用两个 Border 叠加模拟进度 |
| 纯文字展示 | **TextBlock** | 用 Border 承载文字 |
| 玩家输入文字 | **EditableText** / **EditableTextBox** | 用 TextBlock + 点击事件 |
| 可滚动列表内容 | **ScrollBox** | 用大 CanvasPanel 超出边界 |
| 固定格子排列 | **UniformGridPanel** | 手动等距放多个 Border |
| 物品格子（可数据驱动） | **TileView** | 手动复制 N 个 Border |
| 下拉选择 | **ComboBox** | 用 Border + 手写列表逻辑 |
| 勾选框 | **CheckBox** | 用图片切换 + 点击事件 |
| 分割线 | **Border**（h=1~2，无子节点） | 用 TextBlock 显示横线字符 |
| 图标/图片 | **Image** | 用 Border + 背景色填充 |

### 反模式：WeightBG 案例

```
❌ 当前实现（bag2.session）：
  WeightBG (Border)           ← 外框
    └─ WeightFill (Border)    ← 用宽度表示进度（50% = w/2）

✅ 应改为：
  WeightBar (ProgressBar)     ← 直接使用 ProgressBar，设 percent 属性
```

**规则**：凡是"外框 + 内框用宽/高百分比表示数值"的结构，统一替换为 **ProgressBar**。

---

## 二、坐标规范

### 2.1 坐标系说明

- **子节点坐标（x, y）是相对于父容器左上角的偏移量**，不是画布绝对坐标。
- 跨容器的节点不能直接比较坐标值来判断是否重叠。

### 2.2 不可重叠原则

- **同一父容器下，兄弟节点的矩形区域不应相交**。
- 重叠通常由 AI 生成坐标时精度不足导致，修正方式：
  - 手动拖拽到对齐位置（8px 网格自动吸附）
  - 在属性面板直接修改 x/y/w/h 数值

### 2.3 对齐建议

| 场景 | 推荐值 |
|---|---|
| 水平排列间距 | 0px（无间距）或 4/8/16px |
| 垂直排列间距 | 0px（无间距）或 4/8/16px |
| 最小网格单位 | 8px |
| 图标尺寸 | 16/24/32/48px |

---

## 三、命名规范

### 格式
```
功能名称 (控件类型)
```

### 示例

| ✅ 好的命名 | ❌ 差的命名 |
|---|---|
| `HpBar (ProgressBar)` | `Border_123` |
| `ItemIcon (Image)` | `image1` |
| `WeightBar (ProgressBar)` | `WeightBG (Border)` ← 名称暗示是背景但实为进度条 |
| `Divider (Border)` | `rect_line` |
| `RootCanvas (CanvasPanel)` | `canvas` |

### 命名规则
1. 功能名用**大驼峰**（`HpBar`，`ItemName`）
2. 括号内类型名必须与 `widgetType` 字段**一致**
3. 容器前缀建议：`Root`、`Container`、`Panel`、`Group`
4. 背景框前缀：`BG`（仅纯装饰 Border，无子节点）

---

## 四、层级规范

### 4.1 容器选型

| 需求 | 容器 |
|---|---|
| 自由定位子元素 | **CanvasPanel** |
| 水平线性排列 | **HorizontalBox** |
| 垂直线性排列 | **VerticalBox** |
| 固定尺寸包裹 | **SizeBox** |
| 带背景/描边的容器 | **Border** |
| 内容超出时滚动 | **ScrollBox** |
| 多层堆叠 | **Overlay** |

### 4.2 嵌套深度

- **推荐**：不超过 5 层嵌套
- **警告**：超过 7 层应考虑重构

### 4.3 EntryClass 规范

- TileView 必须有且仅有一个 `EntryClass` 子节点
- EntryClass 定义单个 Tile 的外观与交互
- EntryClass 内部可自由嵌套，但尺寸由 TileView 的 `entrySize` 决定

---

## 五、ProgressBar 专项规范

```
widgetType: "ProgressBar"
widgetProps:
  percent: 0~1         ← 当前值比例（如 0.5 = 50%）
  barColor: "#c8a96b"  ← 进度颜色
  bgColor: "rgba(0,0,0,0.6)"  ← 背景色
  borderColor: "#4a3220"      ← 边框色
  borderWidth: 1
```

渲染时显示为 `[████░░░░]` 横向进度条，自动根据 percent 计算宽度。

---

## 六、锚点系统规范

### 6.1 锚点预设作用

属性面板中的 4×4 **锚点预设格**（Anchor Picker）点击后会：
1. **更新锚点元数据**（minX/minY/maxX/maxY）
2. **物理移动（或缩放）控件** 到预设位置

### 6.2 行为定义

| 锚点类型 | 行为 |
|---|---|
| 点锚（minX=maxX, minY=maxY） | 移动控件，不改变尺寸。控件对应的边（左/中/右 × 上/中/下）对齐到父容器的对应位置 |
| H-拉伸（minX≠maxX） | 控件左边界、宽度均随父容器宽度百分比更新 |
| V-拉伸（minY≠maxY） | 控件上边界、高度均随父容器高度百分比更新 |
| 全拉伸（minX≠maxX 且 minY≠maxY） | 控件填满父容器 |

### 6.3 点锚定位公式

```
box.x = parent.x + minX × parent.w - minX × box.w
box.y = parent.y + minY × parent.h - minY × box.h
```

例：居中 (minX=0.5, minY=0.5) → `box.x = parent.x + 0.5×parent.w - 0.5×box.w`

### 6.4 常见使用场景

| 场景 | 使用的锚点预设 |
|---|---|
| 控件在父容器居中 | 居中（第2行第2列） |
| 控件填满父容器宽度 | 水平拉伸-中 |
| 控件固定在右下角 | 右下 |
| 控件固定在顶部居中 | 上中 |

### 6.5 注意事项

- 所有坐标均为**画布绝对坐标**，不是相对父容器的偏移
- 锚点预设会调用 **Ctrl+Z** 可撤销
- 若控件**没有父容器**，父容器边界退化为视口大小（约 800×600）

---

## 七、待修正清单（bag2.session）

| 节点 | 当前类型 | 应改为 | 原因 |
|---|---|---|---|
| `WeightBG (Border)` + `WeightFill (Border)` | Border×2 | `WeightBar (ProgressBar)` | 用 Border 宽度模拟进度条 |

---

*最后更新：2026-03-13*
