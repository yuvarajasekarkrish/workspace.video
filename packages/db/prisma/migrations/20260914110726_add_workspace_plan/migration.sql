-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('startup', 'team', 'company', 'large', 'enterprise');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "plan" "WorkspacePlan" NOT NULL DEFAULT 'startup';
