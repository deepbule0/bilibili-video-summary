import { SiteNav } from "@/components/site-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sections = [
  ["服务与计费", "免费试用额度为每个账号一次，共30分钟。标准版按30天购买，每7天提供500分钟；高级版按30天购买，在可用算力和公平使用范围内不限量并优先处理。视频时长以平台读取结果为准，处理失败不扣除额度。"],
  ["付款与退款", "付款结果以支付宝服务器通知为准。重复通知不会重复开通套餐。未开始的重复订单、系统故障导致无法提供的服务，可通过订单号申请核查；已大量使用的数字服务按实际使用情况处理。"],
  ["个人信息", "服务仅收集提供账号、支付、任务处理与安全保障所必需的信息，包括账号标识、邮箱、经验证的手机号、订单、视频链接、任务状态和用量记录。手机号在界面中脱敏显示，验证码只保存不可逆校验值。"],
  ["内容与保存", "用户应只提交自己有权访问和处理的视频。临时音频只用于转写，工作节点应在任务完成后按配置自动清理。总结和转写可能存在识别错误，重要信息需回看原视频核对。"],
  ["账号与滥用", "不得通过批量注册、自动化攻击、共享账号或其他方式绕过额度和公平使用限制。异常任务可暂停处理并保留必要安全日志。"],
  ["AI 内容提示", "页面输出为人工智能生成内容，仅用于信息整理，不构成投资、医疗、法律或其他专业建议。导出内容应保留人工智能生成提示和原视频链接。"],
];

export default function LegalPage() {
  return <main className="min-h-screen bg-background text-foreground"><div className="mesh" /><SiteNav compact /><article className="relative z-10 mx-auto max-w-3xl px-5 pb-20 pt-8 sm:px-8"><p className="text-sm text-primary">规则与隐私</p><h1 className="mt-1 text-3xl font-semibold">服务说明</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">这是上线前可直接使用的基础版本。正式对外经营前，应根据实际主体、短信服务商、服务器位置和退款政策完成法律审核并补充经营者信息与联系方式。</p><div className="mt-8 space-y-4">{sections.map(([title, body]) => <Card key={title}><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><p className="text-sm leading-7 text-muted-foreground">{body}</p></CardContent></Card>)}</div></article></main>;
}
