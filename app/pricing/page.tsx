"use client";

import { useEffect, useState } from "react";
import { Check, Crown, Gauge, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { readJsonResponse } from "@/lib/http-client";

type Plan = { id: "basic" | "premium"; name: string; priceCents: number; weeklyLimitSeconds: number | null; priority: number; unlimited: boolean };

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [buying, setBuying] = useState<string | null>(null);
  useEffect(() => { fetch("/api/plans").then((r) => readJsonResponse<{ ok?: boolean; plans?: Plan[] }>(r)).then((d) => { if (d.ok && d.plans) setPlans(d.plans); }).catch(() => toast.error("无法读取套餐，请稍后重试")); }, []);

  async function buy(planId: string) {
    setBuying(planId);
    try {
      const response = await fetch("/api/billing/create-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId }) });
      const data = await readJsonResponse<{ paymentUrl?: string; error?: string }>(response);
      if (response.status === 401) { window.location.assign(`/signin-with-chatgpt?return_to=${encodeURIComponent("/pricing")}`); return; }
      if (!response.ok || !data.paymentUrl) throw new Error(data.error || "暂时无法创建订单");
      window.location.assign(data.paymentUrl);
    } catch (error) { toast.error(error instanceof Error ? error.message : "下单失败"); }
    finally { setBuying(null); }
  }

  const displayPlans = plans.length ? plans : [
    { id: "basic", name: "标准版", priceCents: 2000, weeklyLimitSeconds: 30000, priority: 20, unlimited: false },
    { id: "premium", name: "高级版", priceCents: 5000, weeklyLimitSeconds: null, priority: 80, unlimited: true },
  ] satisfies Plan[];

  return <main className="min-h-screen bg-background text-foreground"><div className="mesh" /><SiteNav compact />
    <section className="relative z-10 mx-auto max-w-5xl px-5 pb-20 pt-10 sm:px-8">
      <div className="max-w-2xl"><Badge className="mb-4" variant="outline">先试30分钟，再决定</Badge><h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">为实际视频时长付费</h1><p className="mt-4 text-base leading-7 text-muted-foreground">不按总结次数模糊计费。标准版按周重置，高级版在可用算力范围内不限量并优先进入 GPU 队列。</p></div>
      <div className="mt-10 grid gap-5 lg:grid-cols-3">
        <Card className="border-border bg-card/75"><CardHeader><Sparkles className="size-6 text-primary" /><CardTitle>免费试用</CardTitle><CardDescription>每个账号一次</CardDescription></CardHeader><CardContent><p className="text-4xl font-semibold">¥0</p><ul className="mt-6 space-y-3 text-sm"><li className="flex gap-2"><Check className="size-4 text-primary" />30分钟视频总结</li><li className="flex gap-2"><Check className="size-4 text-primary" />完整总结与原始转写</li></ul></CardContent><CardFooter><Button variant="outline" className="w-full" asChild><a href="/signin-with-chatgpt?return_to=%2F" target="_top">注册并试用</a></Button></CardFooter></Card>
        {displayPlans.map((plan) => <Card key={plan.id} className={`relative bg-card/85 ${plan.id === "premium" ? "border-primary/55 shadow-[0_0_60px_rgba(81,216,168,.08)]" : "border-border"}`}>
          {plan.id === "premium" && <Badge className="absolute right-4 top-4"><Crown className="mr-1 size-3" />优先处理</Badge>}
          <CardHeader>{plan.id === "premium" ? <Gauge className="size-6 text-primary" /> : <ShieldCheck className="size-6 text-primary" />}<CardTitle>{plan.name}</CardTitle><CardDescription>30天有效，手动续费</CardDescription></CardHeader>
          <CardContent><p><span className="text-4xl font-semibold">¥{(plan.priceCents / 100).toFixed(0)}</span><span className="text-muted-foreground"> / 月</span></p><ul className="mt-6 space-y-3 text-sm"><li className="flex gap-2"><Check className="size-4 text-primary" />{plan.unlimited ? "可用算力范围内不限量" : `每7天 ${Math.round((plan.weeklyLimitSeconds || 0) / 60)} 分钟`}</li><li className="flex gap-2"><Check className="size-4 text-primary" />{plan.id === "premium" ? "高优先级 GPU 队列" : "标准处理队列"}</li><li className="flex gap-2"><Check className="size-4 text-primary" />详细总结、时间线与全文转写</li></ul></CardContent>
          <CardFooter><Button className="w-full" variant={plan.id === "premium" ? "default" : "outline"} disabled={Boolean(buying)} onClick={() => buy(plan.id)}>{buying === plan.id && <LoaderCircle className="size-4 animate-spin" />}支付宝购买</Button></CardFooter>
        </Card>)}
      </div>
      <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">高级版“不限量”受单个 GPU 节点可用算力、公平使用与异常滥用控制约束；套餐参数可在管理后台修改。购买即表示同意<a className="ml-1 text-primary hover:underline" href="/legal">服务、退款与隐私说明</a>。</p>
    </section><Toaster position="top-center" richColors /></main>;
}
