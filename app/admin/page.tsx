"use client";

import { useEffect, useState } from "react";
import { Activity, CircleDollarSign, Cpu, LoaderCircle, Save, Users } from "lucide-react";
import { toast } from "sonner";
import { SiteNav } from "@/components/site-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import type { AdminSnapshot, ApiMessage } from "@/lib/client-types";
import { readJsonResponse } from "@/lib/http-client";

type PlanDraft = { priceYuan: number | string; weeklyMinutes: number | string; priority: number | string };

export default function AdminPage() {
  const [data, setData] = useState<AdminSnapshot | null>(null); const [drafts, setDrafts] = useState<Record<string, PlanDraft>>({}); const [saving, setSaving] = useState("");
  async function load() { const r = await fetch("/api/admin/overview"); if (r.status === 401) { window.location.assign(`/signin-with-chatgpt?return_to=${encodeURIComponent("/admin")}`); return; } const j = await readJsonResponse<ApiMessage & { dashboard?: AdminSnapshot }>(r); if (!r.ok || !j.dashboard) throw new Error(j.error || "后台读取失败"); setData(j.dashboard); setDrafts(Object.fromEntries(j.dashboard.plans.map((p) => [p.id, { priceYuan: p.priceCents / 100, weeklyMinutes: p.weeklyLimitSeconds === null ? "" : p.weeklyLimitSeconds / 60, priority: p.priority }]))); }
  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((e: unknown) => toast.error(e instanceof Error ? e.message : "后台读取失败")); }, 0); return () => window.clearTimeout(timer); }, []);
  async function save(planId: string) { setSaving(planId); try { const d = drafts[planId]; const r = await fetch("/api/admin/plans", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId, priceYuan: Number(d.priceYuan), weeklyMinutes: d.weeklyMinutes === "" ? null : Number(d.weeklyMinutes), priority: Number(d.priority) }) }); const j = await readJsonResponse<ApiMessage>(r); if (!r.ok) throw new Error(j.error); toast.success("套餐配置已更新"); await load(); } catch (e) { toast.error(e instanceof Error ? e.message : "保存失败"); } finally { setSaving(""); } }
  if (!data) return <main className="min-h-screen bg-background"><SiteNav compact /><div className="grid min-h-[60vh] place-items-center"><LoaderCircle className="size-7 animate-spin text-primary" /></div><Toaster /></main>;
  const cards = [
    ["注册用户", data.metrics.users, Users], ["付费用户", data.metrics.payingUsers, Activity],
    ["累计收入", `¥${(data.metrics.revenueCents / 100).toFixed(2)}`, CircleDollarSign], ["处理分钟", data.metrics.processedMinutes, Cpu],
  ] as const;
  return <main className="min-h-screen bg-background text-foreground"><div className="mesh" /><SiteNav compact /><section className="relative z-10 mx-auto max-w-7xl px-5 pb-20 pt-8 sm:px-8">
    <div><p className="text-sm text-primary">经营后台</p><h1 className="mt-1 text-3xl font-semibold">服务运行概览</h1><p className="mt-2 text-sm text-muted-foreground">收入、用户、任务、额度与套餐配置使用同一套真实数据。</p></div>
    <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value, Icon]) => <Card key={label}><CardContent className="pt-6"><div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{label}</p><Icon className="size-5 text-primary" /></div><p className="mt-3 text-3xl font-semibold">{value}</p></CardContent></Card>)}</div>
    <Tabs defaultValue="jobs" className="mt-6"><TabsList><TabsTrigger value="jobs">任务记录</TabsTrigger><TabsTrigger value="orders">订单记录</TabsTrigger><TabsTrigger value="plans">套餐配置</TabsTrigger></TabsList>
      <TabsContent value="jobs"><Card><CardHeader><CardTitle>最近任务 <Badge variant="outline">失败 {data.metrics.failedJobs}</Badge></CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>用户</TableHead><TableHead>视频</TableHead><TableHead>状态</TableHead><TableHead>时长</TableHead><TableHead>优先级</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{data.recentJobs.map((job) => <TableRow key={job.id}><TableCell>{job.email}</TableCell><TableCell className="max-w-[22rem] truncate">{job.title || job.id}</TableCell><TableCell><Badge variant="outline">{job.status}</Badge></TableCell><TableCell>{Math.ceil(job.durationSeconds / 60)} 分钟</TableCell><TableCell>{job.priority}</TableCell><TableCell>{new Date(`${job.createdAt}Z`).toLocaleString("zh-CN")}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></TabsContent>
      <TabsContent value="orders"><Card><CardHeader><CardTitle>最近订单</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>订单</TableHead><TableHead>用户</TableHead><TableHead>套餐</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{data.recentOrders.map((order) => <TableRow key={order.id}><TableCell className="font-mono text-xs">{order.id}</TableCell><TableCell>{order.email}</TableCell><TableCell>{order.planId}</TableCell><TableCell>¥{(order.amountCents / 100).toFixed(2)}</TableCell><TableCell>{order.status}</TableCell><TableCell>{new Date(`${order.createdAt}Z`).toLocaleString("zh-CN")}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></TabsContent>
      <TabsContent value="plans"><div className="grid gap-4 lg:grid-cols-2">{data.plans.filter((p) => ["basic", "premium"].includes(p.id)).map((plan) => <Card key={plan.id}><CardHeader><CardTitle>{plan.name}</CardTitle></CardHeader><CardContent className="grid gap-4"><label className="grid gap-2 text-sm">月费（元）<Input type="number" min="1" value={drafts[plan.id]?.priceYuan ?? ""} onChange={(e) => setDrafts({ ...drafts, [plan.id]: { ...drafts[plan.id], priceYuan: e.target.value } })} /></label><label className="grid gap-2 text-sm">每周分钟数（留空为不限量）<Input type="number" min="1" value={drafts[plan.id]?.weeklyMinutes ?? ""} onChange={(e) => setDrafts({ ...drafts, [plan.id]: { ...drafts[plan.id], weeklyMinutes: e.target.value } })} /></label><label className="grid gap-2 text-sm">队列优先级（0–100）<Input type="number" min="0" max="100" value={drafts[plan.id]?.priority ?? ""} onChange={(e) => setDrafts({ ...drafts, [plan.id]: { ...drafts[plan.id], priority: e.target.value } })} /></label><Button onClick={() => save(plan.id)} disabled={saving === plan.id}>{saving === plan.id ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存配置</Button></CardContent></Card>)}</div></TabsContent>
    </Tabs>
  </section><Toaster position="top-center" richColors /></main>;
}
