-- AlterEnum
ALTER TYPE "WorkspaceRole" ADD VALUE 'designer';

-- CreateTable
CREATE TABLE "room_layout_versions" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "map" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "room_layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_layout_versions_roomId_idx" ON "room_layout_versions"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_layout_versions_roomId_version_key" ON "room_layout_versions"("roomId", "version");

-- AddForeignKey
ALTER TABLE "room_layout_versions" ADD CONSTRAINT "room_layout_versions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_layout_versions" ADD CONSTRAINT "room_layout_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_layout_versions" ADD CONSTRAINT "room_layout_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

