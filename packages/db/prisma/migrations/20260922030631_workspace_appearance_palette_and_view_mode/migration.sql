-- CreateEnum
CREATE TYPE "WorkspaceAccentPalette" AS ENUM ('coral', 'cyan', 'emerald', 'indigo', 'amethyst', 'lime');

-- CreateEnum
CREATE TYPE "WorkspaceViewMode" AS ENUM ('flat', 'tilted');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "accentPalette" "WorkspaceAccentPalette",
ADD COLUMN     "viewMode" "WorkspaceViewMode";
