# PCL 启动接口的 REA 分析

分析对象：`../Plain Craft Launcher 2.exe`，SHA-256：
`ff36c5d67cf5cd97322e7639cb54533410303c0dceba17f7b21feb1d5475f8fc`。
REA 将它识别为 .NET Framework 4.8 的托管 PE，程序集版本 2.12.8.2。
这里使用静态元数据与 CIL 分析，没有运行或修改 EXE。

复查命令：

```powershell
rea.cmd inspect-managed-artifact 'Plain Craft Launcher 2.exe'
rea.cmd inspect-managed-members 'Plain Craft Launcher 2.exe' --type PCL.ModLaunch --format json
rea.cmd inspect-managed-members 'Plain Craft Launcher 2.exe' --type PCL.Settings --format json
```

`PCL.ModLaunch.McLaunchCustom` 的方法令牌是 `0x06000a13`。
其 CIL 字符串和调用锚点包含 `LaunchAdvanceRun`、`VersionAdvanceRun`、
`LaunchAdvanceRunWait`、`VersionAdvanceRunWait`、`cmd.exe`、`/c "{0}"`，
以及“正在执行全局自定义命令”。该方法读取启动后命令设置，替换启动参数，
然后经 `ProcessStartInfo` 启动 CMD。`PCL.Settings` 的字符串指向
`PCL\Setup.ini`，所以本机在该文件中设置全局 `LaunchAdvanceRun`。

使用方式：PCL 启动 Minecraft 时执行 `start-deepseek-on-pcl.cmd`；
该脚本启动 `scripts/pcl-bridge.mjs`。桥接脚本等到玩家在单人世界选择
“对局域网开放”，从游戏日志读取动态端口，并用 Minecraft 协议确认端口
可连接，再启动 Mindcraft/Mineflayer 的独立 `deepseek` 玩家。
PCL 接口只负责触发外部命令，游戏内行动由 Mineflayer 完成。

已备份修改前的 `../PCL/Setup.ini` 为
`../PCL/Setup.ini.deepseekbot-backup`。本分析对应上述哈希的 PCL 版本；
升级 PCL 后应重新验证设置与启动命令。
