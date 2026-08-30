# 安装部署指南（Windows / DSH web profile）

## 1. 部署宿主插件（常驻，所有会话生效）

### 1.1 放置插件

把 `plugin/` 目录复制到 DSH web profile 的插件目录：

```
D:\DSH\profiles\web\plugins\skill-evolve-host\
├── index.js
└── package.json
```

### 1.2 建立依赖 junction（让插件能 import `@deepseek-ai/dsh-tools`）

```powershell
New-Item -ItemType Directory -Force -Path 'D:\DSH\node_modules\@deepseek-ai'
New-Item -ItemType Junction -Path 'D:\DSH\node_modules\@deepseek-ai\dsh-tools' `
  -Target 'C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools'
```

> 目标路径以你机器上 dsh 安装位置为准（`npm root -g` + `@deepseek-ai\dsh`）。

### 1.3 挂载到宿主组合

编辑 `D:\DSH\profiles\web\cordis.patch.yml`，追加：

```yaml
- insert:
    - id: skill-evolve-host
      name: ./plugins/skill-evolve-host/index.js
```

### 1.4 重启 DSH

```powershell
# 验证组合已包含该行
dsh --profile web --dump-config | Select-String skill-evolve-host
# 重启后验证
Invoke-WebRequest http://127.0.0.1:3080/skill-evolve     # 仪表盘 200
Invoke-WebRequest http://127.0.0.1:3080/api/skill-evolve/state
```

## 2. 数据位置与重置

- 演化数据根：`D:/DSH/.skill-evolve/`（`global-skills/`、`workspaces/`、`promotion-pool/`、`metrics/` 8 张 JSON 表、`config.json`）
- 全部删除该目录 = 全新开始
- 测试沙箱：`D:/DSH/.skill-evolve/test-run/`（`evolve_selftest` 使用，自动清理）

## 3. 配置（`D:/DSH/.skill-evolve/config.json`，或仪表盘/设置页调整）

| 键 | 默认 | 说明 |
|---|---|---|
| allow_auto_promote | true | 允许工作区技能自动升级全局 |
| allow_auto_demote | true | 允许全局技能自动降级 |
| allow_auto_generate_skill | true | 允许能力缺口自动生成 |
| observer_mode_only | false | 观察者模式：只观察不应用 |
| auto_generate_threshold | 3 | 连续缺失次数触发生成 |
| blocklist_threshold | 3 | 拒收次数达到后永久黑名单 |
| promotion_threshold | 0.001 | 升级占比阈值 |
| demotion_threshold | 0.0001 | 降级双窗口占比阈值 |
| promotion_success_rate | 0.92 | 升级成功率阈值 |
| cooldown_days | 30 | 升降级冷却期 |

## 4. 升级插件

编辑 `D:\DSH\profiles\web\plugins\skill-evolve-host\index.js` → 重启 DSH 生效（无需其他操作）。

## 5. 常见问题

- **卡片栏不显示**：确认 `/skill-evolve/ui.js` 返回 200、首页 HTML 含 `<script src="/skill-evolve/ui.js">`；若被前端 CSP 拦截，改用浏览器控制台检查报错。
- **工具不可见**：确认 `dsh --profile web --dump-config` 组合树含 `skill-evolve-host`；工具注册在宿主层，所有会话的 Agent 均可调用。
- **重新部署后数据丢了**：`.skill-evolve` 目录被删除所致；正常重启不影响。
