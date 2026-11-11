# 日志记录
- 必须区分日志级别: debug,info,warn,error
- 区分日志类型：业务日志，请求日志
- 日志输出到控制台，便于K8s来手机
- 日志输出用json格式
- 每条日志必须有：timestamp， level， log_type
- log_type分类：
  - business ：业务日志
  - http: 服务发起的外部请求
  - access: 服务被外部请求记录
  - exception: 程序异常
- 日志样例：
``` 
{"timestamp":"2026-11-10T10:00:00Z","level":"INFO","log_type":"business","trace_id":"abc123","message":"订单创建成功","order_id":"10001"}
{"timestamp":"2026-11-10T10:00:01Z","level":"INFO","log_type":"http","trace_id":"abc123","method":"POST","path":"/api/orders","status":200,"duration_ms":35}
{"timestamp":"2026-11-10T10:00:02Z","level":"ERROR","log_type":"error","trace_id":"def456","message":"数据库连接超时"}
```
## log_type:http 日志记录要求
- method：请求方法
- path: 路径
- duration_ms: 耗时
- status: 响应状态码

## log_type:exceiton 日志记录要求
- exceptionInfo: 记录代码堆栈，便于后续定位
