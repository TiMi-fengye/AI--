# MySQL关系化存储与迁移

2026-11-23开发更新。关系化代码、显式迁移和备份适配已实现；生产切换以新的固定版本 `MYSQL_RELATIONAL_OK` 回执为准。此前单独审批版本的命令不能代替本次数据库迁移发布。2026-11-24原发布入口出现NameError，旧工具直接执行命令已停用，修复重试见本页末尾。

## 存储与同步

正式运行默认 `HR_STORAGE_MODE=mysql`，必须启用、配置MySQL并完成显式迁移。启动仅检查初始化及版本，不创建或读写 `system_snapshots`，不从旧JSON自动导入，也不写 `snapshot.json` 镜像；数据库不可用时返回失败，不自动降级文件模式。显式 `HR_STORAGE_MODE=file` 仅供开发和独立临时测试，不能作为此次生产验收结果。

前端继续通过历史 `/api/data/snapshot.json` 接口整包同步自己有权访问的数据。该URL名称为兼容已有客户端而保留，传输JSON不等于数据库使用快照存储。后端从关系行组装返回内容；保存时在事务内核对revision并比较行，只插入、更新或删除确实变化的记录，不整表清空重写。多实例并发旧版本返回409。

业务及身份共24张正式表，旧 `system_snapshots` 仅作为冻结的迁移前核对材料保留：

| 数据 | 正式表 |
| --- | --- |
| 人员档案、工号、附件 | hr_employees |
| 考勤、加班、请假 | hr_attendance、hr_overtime、hr_leave_requests |
| 审批历史 | hr_approval_history |
| 通知、模板参数、逐账号发送状态 | hr_approval_notifications、hr_notification_parameters、hr_notification_deliveries |
| 结算及明细 | hr_settlements、hr_settlement_records |
| 绩效及各维度得分 | hr_performance、hr_performance_scores |
| 部门、更新日志、组织树 | hr_departments、hr_update_logs、hr_organization_nodes |
| 同步版本、结构状态及扩展属性 | hr_schema_meta、hr_sync_properties |
| 账号及楼栋/区域授权 | hr_accounts、hr_account_buildings、hr_account_regions |
| 身份版本、组织选项和历史楼长配置 | hr_auth_meta、hr_organization_option_keys、hr_organization_options、hr_organization_leaders |

姓名、手机号、工号、楼栋、区域、时长、状态和日期等已知字段使用实际SQL列，是读取时的权威来源；业务字段列使用 `v_` 前缀，例如 `v_name`、`v_employee_no`、`v_hours`。账号表使用对应的账号列。row_key用于稳定行关联，原id及employeeId仍原值保留。extras仅保存旧版本未知字段，field_state用于区分字段缺失、null和旧类型，不保存业务全集。历史关联缺失的记录不擅自删除。旧日期与新分钟字符串保留原格式，附件、数组顺序和前导零工号必须逐字段一致。

账号和组织配置迁移后以SQL为准。注册人员和账号、同步改名等关联写入共享一次数据库事务；角色和密码状态从SQL刷新，撤权或改密后原会话不能沿用旧权限。新审批流程、管理员删除权限及现有余额约束保持。

## 迁移与切换

`server/migrate-mysql.js` 为显式维护工具，导入模块不会读取配置或运行迁移：

| 模式 | 行为 |
| --- | --- |
| --check（默认） | 只读检查旧源、目标及源摘要，不建表、不修改业务 |
| --apply | 仅应用已停止时执行；事务外建DDL，事务内迁移全部业务、账号和组织，核对内容后写完成标记并提交 |
| --verify | 在线只读校验新库；返回24表摘要、数量、版本和语义摘要，不读旧源文件 |
| --export-rollback 绝对路径 | 应用停止时导出当前新库恢复包，限root私有目录/0600文件，不直接覆盖旧源 |

MySQL的建表语句会隐式提交，因此不能声称“建表也全部回滚”；数据迁移在独立事务内完成，失败不生成完成标记。目标有未知或冲突数据、源在迁移期间变化、内容/附件/顺序不符均拒绝切换。完成后重试只核对，不覆盖；若旧程序在回退后又修改旧源，源摘要不同则需审阅，不能盲目重复迁移。[MySQL隐式提交说明](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)。

新定向发布先核对固定清单和生产基线，生成并校验完整备份。停服后建立root控制的 `/run/hr-system-relational-migration.hold`，迁移并启动新程序时暂为只读：API写入503，后台通知不发送。核对新关系数据与迁移摘要、原文件/旧行不变、源码权限、访问边界及新备份后，才解除闸门开放写入。解除是切换提交点；之后出现故障不能直接启动读取旧源的程序覆盖新写入。

提交前失败只有确认闸门属于本次、原文件和旧行未变、新关系数据未被外部修改时才恢复旧代码；无法确认时保留只读状态及恢复材料交管理员核对。不会删除旧表、新关系表或任何成功备份来掩盖故障。正常源码保持root:hrsystem只读，服务仍以hrsystem运行。

## 自动备份与恢复

原 `hr-system-backup.timer` 已于2026-11-18启用，继续每天北京时间02:00运行；本次不重装或改变timer/service/wrapper，只更新受控备份工具及其安装摘要。新工具校验24表和完整初始化标记，继续对整个数据库生成事务性SQL转储，不只导出旧表。成功备份保存到 `123.56.175.4:/var/backups/hr-system/daily/`，按完成时间戳保留全部，root0700目录/0600文件。

恢复应选同一时间戳的程序、SQL、配置和文件材料：关系化版本恢复全部关系表，账号和组织也从SQL恢复；旧版本备份需与旧程序及旧账号/组织文件配套。恢复旧JSON不能恢复新MySQL数据。先verify、另存当前状态，再在维护窗口恢复；校验备份不等于已在生产演练恢复。异地副本仍待配置，详见[每日备份与恢复](11-每日备份与恢复.md)。

真实MySQL验证由独立CI的MySQL8服务完成，只创建带测试前缀的临时库，缺环境时强制任务失败。常规回归使用显式file临时数据；测试不会读取本机私有配置、生产账号或真实人员资料。

## 本次验证与发布状态

固定版本 `abf244ec868b2b46f45297bd332652e50dc06e6a` 的[CI 45205653158](https://github.com/TiMi-fengye/AI--/actions/runs/45205653158)已通过架构、普通回归、真实MySQL8和临时root权限检查；三个真实数据库集成实际执行通过。普通回归361项357通过4条件跳过，SQL专项42项41通过1权限条件跳过，该权限另由root21项全通过覆盖，全部0失败。固定发布命令已提供，生产仍待 `MYSQL_RELATIONAL_OK` 回执；没有使用真实人员测试、发送真实短信或在生产演练恢复。

## 2026-11-24 发布入口NameError修复

所有者执行原命令后报告 `Relational publication stopped: NameError`。发布器遗漏 `datetime` 导入，异常发生在完整每日备份生成并校验之后、创建本次私有发布备份目录时，尚未调用建立闸门、停服或迁移的事务发布函数。公网认证状态仍200，公开脚本摘要仍与旧版本一致；没有据此宣称SQL迁移完成。此前测试覆盖迁移及事务发布，却未走到main创建备份目录这段编排，新回归须补齐这一缺口。

重试采用两个独立固定目录：修复后的发布器及其实际helper从新审阅版本运行，`--source`仍指向未修改的 `abf244ec868b2b46f45297bd332652e50dc06e6a` 业务包，原始业务清单SHA256仍是 `83e9e6a03a0599fee90a892bfbabb9b800d529b60d66c8dadfae1013426e6e63`。业务、关系表结构和备份core均不因此更新；不能把当前包含AI开发变更的主分支源码作为这次关系化业务源。实际执行的发布器和helper另存于root私有发布备份的 `publication-tool/`，用公开文件摘要记录版本，避免只保留业务包中的旧工具。

再次应用前仍会完整预检和生成并校验备份；源码、数据或工具状态不符时停止。不要删除旧备份、强行解除未知闸门、手工覆盖数据库或重复旧失败命令。收到本次 `MYSQL_RELATIONAL_OK` 后，再单独发布固定AI版本并配置模型；模型密钥不通过聊天或公网HTTP输入。修复工具固定版本和CI结果交付前补记。


修复工具固定版本 [`e04018db368c392a5035db2b6e37ac44c9522d33`](https://github.com/TiMi-fengye/AI--/commit/e04018db368c392a5035db2b6e37ac44c9522d33)已通过[完整Linux、真实MySQL及实际root检查](https://github.com/TiMi-fengye/AI--/actions/runs/45399810036)，原始工具SHA256 `d38eab365e5bf76a9defc5f5fe359af1a9b98f57fb83cbb7d993b8b0e7ee241d`。重试必须从该固定工具目录运行，`--source`仍取原abf业务包；原清单SHA256 83e9e6a03a0599fee90a892bfbabb9b800d529b60d66c8dadfae1013426e6e63。已提供双包重试命令，待新MYSQL_RELATIONAL_OK回执，不能直接重复原工具命令。后续仅补记结果的文档提交不改变这个固定执行版本。
