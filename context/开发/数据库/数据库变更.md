# 数据库开发规范
- 数据库的同步通过执行 @sync_schema.py 来完成
- 表的任何更新变化参照 @database.xsd 的格式来书写
- 表里的所有id都用自增int
- 数据库的表设计时不用加外键约束，通过程序来校验保证即可，便于后续可能发生的数据库迁移
- 数据库底层不做校验，根据xml schema不用生成check tag
- 如果有外键指向，必须用属性ref-table， ref-col 来明确指向，@database.xsd 当中有定义

## 目录规范
本文件下的内容都是参考文件，如果项目中要用，按照以下格式
- 把 @database.xsd 复制到 项目根目录/db 目录下
- 生成的xml数据定义放到 项目根目录/db 目录下
- 执行脚本放到 项目根目录/script 目录下
- Dockerfile 文件中用 RUN 命令执行 数据库同步操作