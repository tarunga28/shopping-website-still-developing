import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { reviews, users } from "@/db/schema";
import { plainText } from "@/lib/plain-text";

/**
 * Approved reviews for one product. Pending / rejected reviews never leave
 * the database. Only a first name is exposed (no email, no surname, no ids).
 */

export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  authorName: string;
  verifiedPurchase: boolean;
  createdAt: string;
}

export interface ProductReviewsDTO {
  count: number;
  average: number | null;
  /** Index 0 = 1 star … index 4 = 5 stars. */
  distribution: [number, number, number, number, number];
  reviews: PublicReview[];
}

export const EMPTY_REVIEWS: ProductReviewsDTO = { count: 0, average: null, distribution: [0, 0, 0, 0, 0], reviews: [] };

export function firstName(name: string | null | undefined): string {
  const first = plainText(name, 60).split(/\s+/)[0];
  return first && first.length > 0 ? first : "Customer";
}

export async function getProductReviews(productId: string, limit = 6): Promise<ProductReviewsDTO> {
  const approved = and(eq(reviews.productId, productId), eq(reviews.status, "APPROVED"));
  const [distributionRows, rows] = await Promise.all([
    db
      .select({ rating: reviews.rating, count: sql<number>`count(*)::int` })
      .from(reviews)
      .where(approved)
      .groupBy(reviews.rating),
    db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        title: reviews.title,
        content: reviews.content,
        verifiedPurchase: reviews.verifiedPurchase,
        createdAt: reviews.createdAt,
        authorName: users.name,
      })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(approved)
      .orderBy(desc(reviews.helpfulCount), desc(reviews.createdAt))
      .limit(Math.min(Math.max(limit, 1), 12)),
  ]);

  const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const entry of distributionRows) {
    if (entry.rating >= 1 && entry.rating <= 5) distribution[entry.rating - 1] = Number(entry.count);
  }
  const count = distribution.reduce((sum, value) => sum + value, 0);
  if (count === 0) return EMPTY_REVIEWS;
  const total = distribution.reduce((sum, value, index) => sum + value * (index + 1), 0);

  return {
    count,
    average: Math.round((total / count) * 10) / 10,
    distribution,
    reviews: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      title: row.title ? plainText(row.title, 120) || null : null,
      body: row.content ? plainText(row.content, 1200) || null : null,
      authorName: firstName(row.authorName),
      verifiedPurchase: row.verifiedPurchase,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
