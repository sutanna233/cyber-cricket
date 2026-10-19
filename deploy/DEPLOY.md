# 部署指南（公网观战 + 注册账号 + 管理员）

游戏是**纯前端静态模拟**：一局对战全部在访客浏览器里跑，服务端只负责发文件、管账号。
所以"权限"保护的是**操作面板**（谁能布阵/调人数/重开），不是对局数据——服务端本来就不存对局。

| 角色 | 能做什么 |
|---|---|
| 游客（未登录） | **只能看**：自动随机开打、自动连场；布阵面板 / 人数 / 重新开始 / 暂停全部不显示（`--mode view`） |
| 游客（`--mode pause`） | 只看 + 暂停/继续（适合直播机位） |
| **注册用户**（登录） | 可以自己布阵玩**自己那一局**：共享角色池拖放/替换/重复部署、开始对战、每侧人数 1~6、暂停、重新开始。**各自独立，互不影响** |
| 管理员 | 注册用户的全部权限 + **用户管理**（查看 / 封禁 / 解封 / 删除）及种子录像导出 |

> 注：默认**不做全员同步**——每个人看的是自己那一局。如果你反而想要"所有人看同一场"，
> 服务端已经内置该能力（`--sync`），见文末「可选的同步观战」。

---

## 一、最快：Docker Compose

```bash
# 1. 上传整个目录到服务器，例如 /opt/cyber-cricket
scp -r ./cyber-cricket user@your-server:/opt/

# 2. 准备密钥
cd /opt/cyber-cricket
cat > .env <<'EOF'
CC_ADMIN_PASS=换成你自己的强密码
CC_SECRET=换成 openssl rand -hex 24 的输出
EOF
chmod 600 .env

# 3. 起服务
docker compose -f deploy/docker-compose.yml up -d --build
```

默认 `127.0.0.1:8130`（只绑本机）。想直接对外就用
`docker run`/compose 把端口改成 `"8130:8130"`，或者按下一节挂 nginx。

## 二、systemd + nginx（不用 Docker）

```bash
# 1. 需要 Node 18+（推荐 22）
node -v

# 2. 放代码
sudo mkdir -p /opt/cyber-cricket
sudo rsync -a --exclude node_modules ./ /opt/cyber-cricket/
sudo chown -R www-data:www-data /opt/cyber-cricket

# 3. 装服务
sudo cp /opt/cyber-cricket/deploy/cyber-cricket.service /etc/systemd/system/
sudo nano /etc/systemd/system/cyber-cricket.service   # 改 CC_ADMIN_PASS / CC_SECRET
sudo systemctl daemon-reload
sudo systemctl enable --now cyber-cricket
sudo systemctl status cyber-cricket --no-pager

# 4. 反代（可选但推荐，配 HTTPS）
sudo cp /opt/cyber-cricket/deploy/nginx.conf /etc/nginx/conf.d/cyber-cricket.conf
sudo nano /etc/nginx/conf.d/cyber-cricket.conf        # 改域名与证书路径
sudo nginx -t && sudo systemctl reload nginx
```

证书最省事：

```bash
sudo certbot --nginx -d cricket.example.com
```

## 三、账号系统（注册 / 登录 / 管理员）

1. 访客打开 `https://你的域名/account.html` → 「注册」页签 → 用户名 + 密码 → 注册成功即自动登录
2. 注册用户回到 `/` 就是完整操作面板，右下角显示「模式 play（可布阵） · 你的用户名」
3. **管理员**：用 `CC_ADMIN_USER` / `CC_ADMIN_PASS` 在同一个页面登录，登录后 `/account.html` 底部出现**用户管理**面板（列出所有账号、封禁/解封/删除）
4. 退出登录：账号页里的「退出登录」

账号数据存在 `--data-dir`（默认 `./data/users.json`），密码用 **scrypt 加盐哈希**（每账号独立盐）。
该目录**不在静态白名单内**，通过 HTTP 访问一律 404（有测试守着）。

登录态是 **HMAC-SHA256 签名的 HttpOnly Cookie**（`cc_session`），服务端不存 session 表；
但**每次请求都会回查用户库**，所以封禁一个账号后，他手上的 Cookie 立刻失效。

> 想强制所有人重新登录：换一个 `CC_SECRET` 再重启。

### 账号相关限制

| 项 | 规则 |
|---|---|
| 用户名 | 2~20 位，中文 / 字母 / 数字 / 下划线 / 连字符 |
| 密码 | 至少 6 位，且不能是纯数字 |
| 登录失败限流 | 同 IP 10 分钟 8 次，超出返回 429 |
| 注册限流 | 同 IP 10 分钟 5 次 |
| 关闭注册 | 启动加 `--no-register`（已有账号仍可登录） |
| 管理员保护 | 管理员账号不能被封禁/删除；`--admin-pass` 是权威密码，改了重启即重置该账号密码 |

## 四、参数速查

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `PORT` | 8130 | 端口（被占用自动 +1） |
| `--host` | `HOST` | 127.0.0.1 | 绑定地址；裸机对外用 `0.0.0.0` |
| `--mode` | `CC_MODE` | view | 访客权限 `view` / `pause` / `play` |
| `--admin-user` | `CC_ADMIN_USER` | admin | 管理员用户名 |
| `--admin-pass` | `CC_ADMIN_PASS` | 空（禁用登录） | 管理员密码；不设则任何人都无法登录 |
| `--secret` | `CC_SECRET` | 每次启动随机 | Cookie 签名密钥；**不设会导致重启后登录失效** |
| `--session-days` | `CC_SESSION_DAYS` | 7 | 登录有效期 |
| `--quiet` | — | 关 | 不打访问日志 |

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/session` | `{role:'guest'|'user'|'admin', mode, user, registerEnabled, syncEnabled, userCount}` |
| POST | `/api/register` | `{user, pass}` → 建号并自动登录（受注册限流） |
| POST | `/api/login` | `{user, pass}` → 下发 HttpOnly Cookie（受登录限流） |
| POST | `/api/logout` | 清 Cookie |
| GET | `/api/admin/users` | 仅管理员：账号列表 |
| POST | `/api/admin/ban` | 仅管理员：`{user, banned:true|false}` |
| POST | `/api/admin/delete` | 仅管理员：`{user}` |
| GET | `/api/round` | 可选同步观战：当前场次信息（未开 `--sync` 时 `enabled:false`） |
| POST | `/api/round/next` | 仅管理员：立即开下一场（需 `--sync`） |

## 五之二、可选的同步观战（`--sync`）

默认关闭（各自玩各自的）。加 `--sync` 后，服务端会当"发令枪"：
决定每场的**种子 + 双方阵容 + 开始时刻**，并预跑算出结束时间，到点自动开下一场；
客户端（`?sync=1` 或服务端注入）用同一种子本地确定性重放并快进到当前进度，
于是**所有人看到同一场、同一个瞬间**。管理员可在账号页点「开下一场」（`/api/round/next`）。

## 六、安全说明（请读一遍）

- **只暴露游戏需要的文件**：`index.html` / `admin.html` / `sim-watch.html` / `styles.css` / `js/**` / `assets/**`。
  `server.js`、`tools/`、`tests/`、`docs/`、`.env`、`tools/.nai_token` 一律 **404**（有测试守着）。
- **目录穿越**已拦截（`..%2f` 之类），并有 `/api/login` 限流。
- Cookie 是 `HttpOnly + SameSite=Lax`；HTTPS 下建议在 nginx 再加 `Secure`（本仓库 Node 端没写死 Secure，方便你本机 http 调试）。
- **这不是数据权限边界**：访客就算在控制台里手动调 `CC.board.place()` 也只会影响**他自己浏览器里那一局**，不影响别人，也不改服务器任何东西。
  如果你要的是"所有人看同一场、只有管理员能开新局"，那需要把模拟搬到服务端（当前架构不做，属于另一个量级的改造）。
- 别忘了改掉示例密码；`CC_SECRET` 用 `openssl rand -hex 24` 生成。

## 七、验收清单

```bash
# 1) 访客视角：只能看
curl -s https://你的域名/ | grep -o '__CC_ROLE__="[a-z]*"'     # → "view"
#    浏览器打开应看不到布阵面板 / 重新开始按钮，右下角显示「仅观看」

# 2) 管理员视角
#    浏览器登录 /admin.html 后：布阵面板出现、可拖拽、可调人数、可重开

# 3) 自动化（本机跑）
node tools/_leadcheck/auth.js        # 22 项：登录/伪造 Cookie/限流/穿越/源码不出网/gzip/缓存
node tools/verify_all.ps1            # 全部玩法与资产验收
```

## 八、常见问题

**Q：打开是白屏 / 只有背景？**
A：先看浏览器控制台。最常见是静态资源 404——确认 `js/` 与 `assets/` 完整上传（`assets/` 约 6MB）。

**Q：右下角显示「仅观看」，但我是管理员？**
A：说明 Cookie 没带上或被 `CC_SECRET` 变更作废了。去 `/admin.html` 重新登录；跨域/反代请确认 `Cookie` 头透传。

**Q：想给某些人暂停权限，但不给布阵？**
A：把 `CC_MODE` 设成 `pause`，他们能暂停/继续，但摸不到布阵面板。

**Q：想给所有人完整操作？**
A：`CC_MODE=play`（不推荐公网；等于谁都能改阵容）。
