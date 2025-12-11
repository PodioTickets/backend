/*
  Warnings:

  - You are about to drop the column `profilePictureUrl` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "profilePictureUrl",
ADD COLUMN     "avatarUrl" TEXT;
