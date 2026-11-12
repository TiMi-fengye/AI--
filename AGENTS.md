# 项目交付约定

## 持续维护架构 HTML

用户要求每次更新都同步更新生成的 HTML。根目录 `人力资源管理系统开发架构.html` 是固定交付文件，不按日期另建多个架构页面。

每次修改代码、权限、数据结构、依赖、部署脚本或项目文档后，交付前必须：

1. 核对当前实现，必要时更新 `技术文档/系统开发架构.source.json` 的架构事实和 `updatedAt`。保留已有更新历史，明确已实现能力和待配置能力。
2. 更新 `updates/YYYY-MM-DD.md`；同一天有多次更新时补充到同一个文件。涉及用户要求的每日自述时同步根目录当日文件。
3. 运行 `node scripts/generate-architecture.cjs`，将更新记录、依赖、模块信息和源码指纹写入同一个 HTML。
4. 运行 `node scripts/generate-architecture.cjs --check`。不允许提交或发布过期 HTML；其他测试按实际代码变更选择。
5. 核对 README 的文档入口，发布清单必须包含本次要交付的文档。历史固定版本部署脚本不承担新版本发布。

生成器只允许读取公开源码，不能读取 `server/config.json`、`server/data`、生产环境变量、日志、凭据或真实人员资料。架构文档不得包含人员信息、真实账号、密码、令牌或备份中的业务数据。

HTML 是自包含离线文档。若用户要求通过网站访问，必须检查服务端静态 HTML 白名单和新版本发布清单，明确开放该文件并验证页面 HTTP 200；不要为文档开放整个运行数据目录。

## 运行与校验

- 本地启动：`node server/server.js`
- 业务测试：`node --test tests/*.test.js`，使用临时测试数据，不写实际数据目录。
- 文档生成：`node scripts/generate-architecture.cjs`
- 文档校验：`node scripts/generate-architecture.cjs --check`
- 持续生成：`node scripts/generate-architecture.cjs --watch`，结束时按 Ctrl+C。
