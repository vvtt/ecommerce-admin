import { Link } from "react-router-dom";
import { Compass, PackageSearch } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { PageHeader } from "@/src/components/shared/PageHeader";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="页面不存在" description="该地址没有对应的后台页面，可能是链接已失效或手输有误。" />

      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-xs">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Compass className="h-7 w-7" />
        </div>
        <p className="text-sm font-semibold text-slate-800">404 Not Found</p>
        <p className="mt-1 text-xs text-slate-500">
          本站只覆盖「商品与库存」域：商品、类目、库存、采购补货。
        </p>

        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => history.back()}>返回上一页</Button>
          <Link to="/products">
            <Button variant="outline">
              <PackageSearch className="h-4 w-4 mr-1.5" />
              去商品列表
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
