# 来源说明

[English](../provenance.md) | [中文入口](../../README.zh-CN.md)。英文为项目主语言。

bridge 从 Kosbling 的 `kosbling-automation` 项目抽取并改造。原仓不是运行依赖；业务代码、凭证、生产记录、Agent 业务指令和 lark-cli 工具未迁入本仓。

沿用的生产行为和部分纯转换逻辑来自 `kosbling-agent/scripts/agent-server.mjs` 与 `kosbling-agent/feishu-transport/scripts/feishu-media.mjs`：消息/post 文本提取与图片 key 选择、用文本传入本地图片路径、输出扩展名/类型选择，以及原有一秒文件选择余量。独立版本增加显式限制、持久快照、源版本归属、线程隔离与受控生命周期；不能称为未经修改的复制，也不能把原生产验证当作改造后已经验证。

飞书/Codex 协议客户端使用声明并锁定的依赖和 Codex app-server 协议。依赖通过 npm 安装，不直接复制进本仓，仍保留各自许可证与声明。

项目尚未选择许可证。仓库公开本身不授予开源许可，本说明不能替代许可证；许可证由所有者另行决定。
