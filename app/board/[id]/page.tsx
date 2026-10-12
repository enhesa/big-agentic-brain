import { redirect } from "next/navigation";
export default async function BoardDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/memory/${id}`);
}
