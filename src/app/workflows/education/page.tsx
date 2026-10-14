import type { Metadata } from "next";
import EducationWorkflowClient from "@/components/education/EducationWorkflowClient";

export const metadata: Metadata = { title: "교육·발표 자료 워크플로" };

export default function EducationWorkflowPage() {
  return <EducationWorkflowClient />;
}
