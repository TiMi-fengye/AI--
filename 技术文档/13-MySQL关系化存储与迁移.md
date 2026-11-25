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

重复编号修复将内部row_key与原业务编号分开：同一集合内，相同类型和值的编号首次出现仍使用旧键，后续出现使用独立重复域及出现次序生成的键。原id、employeeId、字段与ordinal不变；子表继续关联对应父行的内部键。同编号记录相对顺序变化时，事务按新的出现次序同步对应内部行，完整读取仍须与原整包逐字段一致。此映射不放宽应用层人员或申请编号唯一性及权限校验，也不自行修正旧业务引用的歧义；详见本页最新修复状态。

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

## 2026-11-25 迁移阶段诊断

随后执行返回`Relational publication stopped: node command failed`。所有者提供的只读状态为：业务服务active、以hrsystem运行、maintenanceGate=false，最近发布备份已有publication-tool而尚无precommit-proof或成功标记。进一步只读诊断确认24张关系表、元数据行存在、schemaVersion=1、initialized=false；原--check成功并允许迁移。已创建的DDL可以保留，不能把本次结果写成“数据库未变”；也不能以空表预检推断数据编码和SQL写入一定成功。

本次只改发布工具的错误定位：受控Node入口加载并核对原三份SQL模块，取得原CLI，沿用原参数、服务环境、连接路径和迁移流程。成功仍返回原proof；失败仅输出固定阶段、受限错误类别/代码及完整匹配公开静态文字的消息，无法确认的内容隐藏。不打印原始stdout/stderr、SQL、参数、堆栈或账号和人员字段。同步工厂与事务连接函数保持同步，阶段装饰仅包明确的异步方法，保留原事务上下文。

另提供`deploy/diagnose-mysql-relational.py --publication-backup /root/hr-system-backups/对应发布目录`先做只读兼容性诊断。工具核对原83e9归档和三份SQL模块，从只读事务读取旧业务源，用原encode/decode比对完整还原；账号和组织通过原身份工厂的纯内存适配器验证，不连接真实SQL写通道。检查前后源文件及业务摘要变化，变化时停止并要求重试。输出仅固定阶段和允许的静态消息，不输出数量、摘要或数据。此工具不执行--apply、不停止业务、不建表、不备份或修改生产文件；通过不代表SQL列约束及真实读回一定通过。

原业务包、83e9固定清单及备份core保持。新工具需通过合成隐私/异常测试、原MySQL集成和实际root发布验证后才提供新的固定双包命令；旧失败命令不重复使用。再次执行仍先完整备份，在原停服闸门和受控回滚机制内调用原迁移，失败只报告诊断，不删数据或强行开放闸门。收到MYSQL_RELATIONAL_OK之前，不发布AI或输入DeepSeek密钥。

固定诊断/工具版本[`7385b3d0265c9fb1827ee96ed5c3d4221555ebb0`](https://github.com/TiMi-fengye/AI--/commit/7385b3d0265c9fb1827ee96ed5c3d4221555ebb0)已通过[CI 45549448309](https://github.com/TiMi-fengye/AI--/actions/runs/45549448309)。Linux完整452项445通过7条件跳过；真实MySQL8专项61项58通过3权限条件跳过；实际root41项全通过0跳过，全部0失败。新受控入口的实际MySQL检查确实执行了原CLI、账号字段失败后的事务回滚、修改合成输入后重新迁移及24表proof。下一步优先从此固定包运行只读诊断，针对已确认的原发布归档，不在未知原因下重跑正式迁移。本段验收文档仅补记结果，固定工具和原83e9业务源不变。

所有者随后执行上述诊断返回`helper-audit`停止，尚未读取业务源。实际GitHub codeload tar的目录为0775、普通文件0664，root解压保留了组写权限，被严格检查正确拒绝；此前测试遗漏真实tar解压权限。修复仅将helper来源改为同一发布归档已受保护的publication-tool副本，继续原C69E摘要和路径/权限检查，不放宽保护。新增真实root tar权限回归，CI root专项实际执行该测试。旧7385诊断命令不再重复运行；修复固定版本及验证结果以今日最新记录为准，原业务源及83e9清单保持。

替换诊断固定版本[`d34ac4ae73b9db83334e489162c3c7baca0aac5e`](https://github.com/TiMi-fengye/AI--/commit/d34ac4ae73b9db83334e489162c3c7baca0aac5e)通过[CI 45551988601](https://github.com/TiMi-fengye/AI--/actions/runs/45551988601)：Linux454项446通过8条件跳过、真实MySQL63项59通过4权限条件跳过、实际root54项全通过0跳过。root日志确认上述真实tar及私有helper加载/拒绝测试已运行；原wrapper实际MySQL测试仍通过。生产仍先执行此固定版只读诊断，尚未收到兼容性结果或MYSQL_RELATIONAL_OK，不以CI成功代替生产迁移验收。

## 2026-11-25 重复编号无损迁移修复

迁移专用源码固定为[`fa9cf24a78d08373c8172e7b974b9bf8a85d585f`](https://github.com/TiMi-fengye/AI--/commit/fa9cf24a78d08373c8172e7b974b9bf8a85d585f)，从原abf树独立生成；新清单原始SHA256为14031f871fc1432e43544d844c71bc179e05ce5a9fb049858d28832c4ac52313。该固定包同时包含修复工具及完整迁移源，单包即可执行，不从main抽取待发布AI程序。[CI 45564212753](https://github.com/TiMi-fengye/AI--/actions/runs/45564212753)通过：Linux372项365通过7条件跳过，实际MySQL53项50通过3权限条件跳过，实际root28项全部通过0跳过；四个真实数据库集成均执行，重复记录及子行保真、回滚与后续差量保存通过。生产MYSQL_RELATIONAL_OK仍待执行回执。

所有者随后提供d34只读回执：`MYSQL_RELATIONAL_COMPATIBILITY_ERROR`，阶段`business-encode`，静态消息“同一集合记录编号重复”，且`readOnly=true`、`databaseWritten=false`、`serviceRestarted=false`。这次已经定位到原编码器拒绝重复编号；诊断没有执行迁移或修改资料。当前未确定重复发生在哪个集合、如何产生，不能将代码中可能使用时间戳的生成方式当作生产原因证明。

本次存储映射为每条同编号记录保留独立的关系行，原业务编号、类型、记录顺序、全部字段及子关联均保留。首条键不变，后续键加入重复域和出现次序，避免SQL主键冲突。重复记录不被删去或合并，原业务id不重写，DDL与schemaVersion不变；应用层角色、数据范围、编号唯一性和审批约束保持。实际MySQL写入与读取、附件、子记录、差量更新和回滚仍须通过完整验证后才可切换。

迁移发布使用从原abf审阅树构建的新固定源码和新清单，保留原无OTP生产候选与备份core，避免把主分支待发布AI或短信验证码代码整体覆盖到生产。原83e9清单与既往命令仅作历史依据，不能直接承担本次修复发布。新源码与工具固定提交、清单摘要和验证结果交付前补记；AI发布清单需适配新的关系化基线，原24021固定AI包不直接用于修复后版本。

切换仍先生成并校验完整备份，保护现有源码权限、hrsystem服务用户及每日02:00任务；沿用原冻结核对、只读闸门、提交点和受控回滚机制。当前业务服务仍为旧版本，尚待MYSQL_RELATIONAL_OK；之后才发布适配的AI版本并由所有者私下输入DeepSeek密钥、执行真实连接测试。这里记录的修复方案和合成验证不等于生产迁移、AI上线或模型已配置。
