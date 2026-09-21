# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

- 三栏：`NodeLibrary`（搜索+历史/我的/常用+draggable）/ `CompareSlots`（A/B drop+swap/clear+scope+表过滤+进度）/ `DiffTable`（一级Tab计数+二级对象过滤+选中行）/ `SqlPreview`。单文件内拆函数可接受，状态走zustand `store.ts`。

---

## Props Conventions

- 复制内容必须=所见（`toExportSql`同源，头注释A/B/时间），DROP复制二次confirm。

---

## Styling Patterns

- 深色智能化，DROP红警+风险徽标；SQL高亮先占位注释/字符串/标识符（PUA）再染关键字，防串内关键字误标。

---

## Common Mistakes

- 常用Tab硬阈值致新节点永不入围 → 置顶或用过即入围按频次倒序；`useMemo`依赖勿放每render新引用。

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)
