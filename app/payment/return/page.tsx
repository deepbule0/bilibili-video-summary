"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { SiteNav } from "@/components/site-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function PaymentReturnPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setReady(true), 1800); return () => clearTimeout(timer); }, []);
  return <main className="min-h-screen bg-background text-foreground"><div className="mesh" /><SiteNav compact /><section className="relative z-10 mx-auto grid min-h-[65vh] max-w-xl place-items-center px-5"><Card className="w-full"><CardContent className="py-12 text-center">{ready ? <CheckCircle2 className="mx-auto size-12 text-primary" /> : <LoaderCircle className="mx-auto size-12 animate-spin text-primary" />}<h1 className="mt-5 text-2xl font-semibold">{ready ? "付款结果正在确认" : "正在确认支付宝订单"}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">套餐以支付宝服务器通知为准，通常几秒内到账。没有到账时请稍后刷新账户页面，请勿重复付款。</p><Button className="mt-6" asChild><a href="/account">查看账户与订单</a></Button></CardContent></Card></section></main>;
}
