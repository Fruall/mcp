// Topic labels extracted from the Ads Transparency Center front-end (main.dart.js and its
// French message bundle), 2026-09-30. Field 16.1.1 of a creative carries a vertical ID;
// the product-category map is used by the same front-end for Shopping-style topics.

export interface TopicLabel {
  en: string;
  fr: string;
}

export const VERTICAL_TOPICS: Record<number, TopicLabel> = {
  10001: { en: "Autos & Vehicles", fr: "Automobiles et véhicules" },
  10002: { en: "Family & Community", fr: "Famille et communauté" },
  10003: { en: "Real Estate", fr: "Immobilier" },
  10004: { en: "Business & Industrial", fr: "Commerce et industrie" },
  10005: { en: "Beauty & Personal Care", fr: "Beauté et soins" },
  10006: { en: "Occasions & Gifts", fr: "Cadeaux et événements" },
  10007: { en: "Internet & Telecom", fr: "Internet et télécoms" },
  10009: { en: "Home & Garden", fr: "Maison et jardin" },
  10010: { en: "Food & Groceries", fr: "Alimentation et épicerie" },
  10011: { en: "Health", fr: "Santé" },
  10012: { en: "Finance", fr: "Finance" },
  10013: { en: "Arts & Entertainment", fr: "Arts et divertissements" },
  10014: { en: "Sports & Fitness", fr: "Sports et fitness" },
  10015: { en: "Hobbies, Games & Leisure", fr: "Passe-temps, jeux et loisirs" },
  10016: { en: "Jobs & Education", fr: "Emploi et enseignement" },
  10017: { en: "Travel & Tourism", fr: "Voyage et tourisme" },
  10018: { en: "Law & Government", fr: "Justice et administrations" },
  10019: { en: "Computers & Consumer Electronics", fr: "Ordinateurs et électronique grand public" },
  10020: { en: "Dining & Nightlife", fr: "Restauration et vie nocturne" },
  10021: { en: "Apparel", fr: "Vêtements" },
  10108: { en: "News, Books & Publications", fr: "Actualités, livres et publications" },
  13934: { en: "Mobile App Utilities", fr: "Applications mobiles utilitaires" },
};

export const PRODUCT_CATEGORY_TOPICS: Record<number, TopicLabel> = {
  1: { en: "Animals & Pet Supplies", fr: "Animaux et articles pour animaux de compagnie" },
  8: { en: "Arts & Entertainment", fr: "Arts et divertissements" },
  111: { en: "Business & Industrial", fr: "Commerce et industrie" },
  141: { en: "Cameras & Optics", fr: "Appareils photo et équipements optiques" },
  166: { en: "Apparel & Accessories", fr: "Vêtements et accessoires" },
  222: { en: "Electronics", fr: "Appareils électroniques" },
  412: { en: "Food, Beverages & Tobacco", fr: "Alimentation, boissons et tabac" },
  436: { en: "Furniture", fr: "Mobilier" },
  469: { en: "Health & Beauty", fr: "Beauté et santé" },
  536: { en: "Home & Garden", fr: "Maison et jardin" },
  537: { en: "Baby & Toddler", fr: "Bébés et tout-petits" },
  632: { en: "Hardware", fr: "Matériel" },
  772: { en: "Mature", fr: "Contenu réservé aux adultes" },
  783: { en: "Media", fr: "Contenu multimédia" },
  888: { en: "Vehicles & Parts", fr: "Automobiles et accessoires" },
  922: { en: "Office Supplies", fr: "Fournitures de bureau" },
  988: { en: "Sporting Goods", fr: "Articles de sport" },
  1239: { en: "Toys & Games", fr: "Jeux et jouets" },
  2092: { en: "Software", fr: "Logiciels" },
  5181: { en: "Luggage & Bags", fr: "Bagages et maroquinerie" },
  5605: { en: "Religious & Ceremonial", fr: "Offices religieux et cérémonies" },
};
