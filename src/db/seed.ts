import { db, pool } from "./index"
import {
  users,
  auditLogs,
  categories,
  menuItems,
  dailyMenuSchedules,
  orderItems,
  orders,
  type dayOfWeekEnum,
} from "./schema"
import { sql } from "drizzle-orm"
import bcrypt from "bcryptjs"

const img = (id: string, w = 800, h = 600) =>
  `https://images.unsplash.com/${id}?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&q=80&w=${w}&h=${h}`

type DayOfWeek = (typeof dayOfWeekEnum.enumValues)[number]

async function seed() {
  console.log("🌱 Starting Banglar Biriyani database seed...")

  try {
    // 1. Clean existing data in reverse order of foreign keys
    console.log("🧹 Cleaning existing tables...")
    await db.execute(sql`
      TRUNCATE TABLE audit_logs, sessions, order_items, orders, daily_menu_schedules, menu_items, categories, users RESTART IDENTITY CASCADE;
    `)

    // 2. Seed Authenticated Users (RBAC) idempotently with bcryptjs (cost 12)
    console.log("👤 Seeding authenticated accounts (Admin, Kitchen Staff, Customer)...")
    const adminPasswordHash = await bcrypt.hash("Admin@1234", 12)
    const staffPasswordHash = await bcrypt.hash("Staff@1234", 12)
    const customerPasswordHash = await bcrypt.hash("Customer@1234", 12)

    const testUsersData = [
      {
        fullName: "Banglar Biriyani Owner",
        email: "admin@banglarbiriyani.com",
        phone: "01711000001",
        passwordHash: adminPasswordHash,
        role: "ADMIN" as const,
        defaultAddress: "Gulshan-2, Dhaka",
        isActive: true,
      },
      {
        fullName: "Head Chef Rahim",
        email: "kitchen@banglarbiriyani.com",
        phone: "01711000002",
        passwordHash: staffPasswordHash,
        role: "STAFF" as const,
        defaultAddress: "Old Dhaka, Lalbagh",
        isActive: true,
      },
      {
        fullName: "Tanvir Ahmed",
        email: "customer@banglarbiriyani.com",
        phone: "01711000003",
        passwordHash: customerPasswordHash,
        role: "CUSTOMER" as const,
        defaultAddress: "House 14, Road 7, Dhanmondi, Dhaka",
        isActive: true,
      },
    ]

    const insertedUsers = await db
      .insert(users)
      .values(testUsersData)
      .onConflictDoUpdate({
        target: users.email,
        set: {
          fullName: sql`EXCLUDED.full_name`,
          phone: sql`EXCLUDED.phone`,
          passwordHash: sql`EXCLUDED.password_hash`,
          role: sql`EXCLUDED.role`,
          defaultAddress: sql`EXCLUDED.default_address`,
          isActive: sql`EXCLUDED.is_active`,
          updatedAt: sql`NOW()`,
        },
      })
      .returning()

    const userMap = new Map(insertedUsers.map((u) => [u.email, u]))
    console.log(`✅ Seeded ${insertedUsers.length} RBAC accounts.`)

    // 3. Insert Categories
    console.log("📦 Seeding categories...")
    const insertedCategories = await db
      .insert(categories)
      .values([
        {
          name: "Signature Biriyani",
          slug: "signature-biriyani",
          sortOrder: 1,
        },
        {
          name: "Tehari & Khichuri",
          slug: "tehari-khichuri",
          sortOrder: 2,
        },
        {
          name: "Kebabs & Sides",
          slug: "kebabs-sides",
          sortOrder: 3,
        },
        {
          name: "Beverages & Desserts",
          slug: "beverages-desserts",
          sortOrder: 4,
        },
        {
          name: "Home-Style Meals",
          slug: "home-style-meals",
          sortOrder: 5,
        },
      ])
      .returning()

    const catMap = new Map(insertedCategories.map((c) => [c.slug, c.id]))

    // 3. Define all authentic Menu Items (reusing images from App.tsx)
    console.log("🍛 Seeding menu items...")
    const itemsData = [
      // Signature Biriyani
      {
        slugKey: "mutton-kacchi",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Saturday Special Shahi Mutton Kacchi",
        description:
          "Slow-cooked mutton layered with aromatic basmati, saffron, potato and fried onions, sealed dum-style.",
        basePriceBdt: 450,
        imageUrl: img("photo-1589302168068-964664d93dc0"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "chicken-biryani",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Chicken Biryani (Dum Murgh)",
        description:
          "Basmati rice dum-cooked with spiced chicken, boiled egg and a hint of rose water.",
        basePriceBdt: 350,
        imageUrl: img("photo-1631515243349-e0cb75fb8d3a"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.8",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "morog-polao",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Tuesday Special Dhakaiya Morog Polao",
        description:
          "Traditional Bengali style tender chicken leg quarter simmered in rich gravy served over aromatic ghee-infused chinigura polao.",
        basePriceBdt: 360,
        imageUrl: img("photo-1631515243349-e0cb75fb8d3a"),
        portionSize: "1:1 Regular",
        spiceLevel: "Mild",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "hyderabadi-biriyani",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Wednesday Special Dum Biriyani",
        description:
          "Long grain basmati rice, layers of spiced marinated chicken, caramelized onions, fresh mint, and saffron milk.",
        basePriceBdt: 390,
        imageUrl: img("photo-1589302168068-964664d93dc0"),
        portionSize: "1:1 Regular",
        spiceLevel: "Spicy",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "roast-polao",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Biye Bari Chicken Roast & Polao",
        description:
          "Rich wedding-style slow-cooked chicken roast with fragrant chinigura polao, fried onions, and raisins.",
        basePriceBdt: 350,
        imageUrl: img("photo-1532636875304-0c89119d9b4d"),
        portionSize: "1:1 Regular",
        spiceLevel: "Mild-Sweet",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "jummah-kacchi-platter",
        categoryId: catMap.get("signature-biriyani")!,
        name: "Friday Royal Jummah Kacchi Platter",
        description:
          "Grand Friday feast featuring prime mutton kacchi, a whole roasted potato, boiled egg, chicken roast, and jali kabab.",
        basePriceBdt: 550,
        imageUrl: img("photo-1589302168068-964664d93dc0"),
        portionSize: "1:1 Grand Platter",
        spiceLevel: "Medium",
        rating: "5.0",
        isEveryday: false,
        isAvailable: true,
      },

      // Tehari & Khichuri
      {
        slugKey: "beef-tehari",
        categoryId: catMap.get("tehari-khichuri")!,
        name: "Sunday Special Old Dhaka Beef Tehari",
        description:
          "Old Dhaka-style tehari with tender beef chunks and aromatic mustard oil cooked with chinigura rice.",
        basePriceBdt: 300,
        imageUrl: img("photo-1697155406055-2db32d47ca07"),
        portionSize: "1:1 Regular",
        spiceLevel: "Spicy",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "chicken-tehari",
        categoryId: catMap.get("tehari-khichuri")!,
        name: "Special Chicken Tehari",
        description:
          "Fragrant short-grain rice tossed with tender chicken, mustard oil, green chillies, and fried beresta.",
        basePriceBdt: 320,
        imageUrl: img("photo-1563379091339-03b21ab4a4f8"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.8",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "bhuna-khichuri-rezala",
        categoryId: catMap.get("tehari-khichuri")!,
        name: "Monday Special Beef Bhuna Khichuri",
        description:
          "Aromatic chinigura rice and roasted moong dal khichuri paired with slow-braised tender beef rezala.",
        basePriceBdt: 380,
        imageUrl: img("photo-1620894580123-466ad3a0ca06"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium-Spicy",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "mutton-tehari-najirshail",
        categoryId: catMap.get("tehari-khichuri")!,
        name: "Thursday Special Najirshail Mutton Tehari",
        description:
          "Succulent mutton bone-in pieces infused with pure mustard oil and cooked with aged Najirshail rice.",
        basePriceBdt: 420,
        imageUrl: img("photo-1697155406055-2db32d47ca07"),
        portionSize: "1:1 Regular",
        spiceLevel: "Spicy",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },

      // Kebabs & Sides (Everyday)
      {
        slugKey: "jali-kabab",
        categoryId: catMap.get("kebabs-sides")!,
        name: "Jali Kebab (2 pcs)",
        description:
          "Crispy egg-laced minced beef patties, pan-fried golden and served with fresh onion salad.",
        basePriceBdt: 100,
        imageUrl: img("photo-1603360946369-dc9bb6258143"),
        portionSize: "2 Pieces",
        spiceLevel: "Medium",
        rating: "4.8",
        isEveryday: true,
        isAvailable: true,
      },
      {
        slugKey: "chicken-roast-side",
        categoryId: catMap.get("kebabs-sides")!,
        name: "Biye Bari Chicken Roast",
        description:
          "Rich, mildly sweet wedding-style roast with ghee, yoghurt, fried onion and golden gravy.",
        basePriceBdt: 180,
        imageUrl: img("photo-1532636875304-0c89119d9b4d"),
        portionSize: "1 Leg Quarter",
        spiceLevel: "Mild",
        rating: "4.9",
        isEveryday: true,
        isAvailable: true,
      },

      // Beverages & Desserts (Everyday)
      {
        slugKey: "borhani",
        categoryId: catMap.get("beverages-desserts")!,
        name: "Shahi Borhani (500ml)",
        description:
          "Spiced yoghurt drink with mint, coriander, mustard and black salt. The essential biryani partner.",
        basePriceBdt: 80,
        imageUrl: img("photo-1692620609860-be6717812f71"),
        portionSize: "500 ml Bottle",
        spiceLevel: "Mild Tangy",
        rating: "4.9",
        isEveryday: true,
        isAvailable: true,
      },
      {
        slugKey: "firni",
        categoryId: catMap.get("beverages-desserts")!,
        name: "Zafrani Firni Cup",
        description:
          "Chilled ground-rice pudding infused with cardamom, saffron, sliced pistachio and almond.",
        basePriceBdt: 70,
        imageUrl: img("photo-1705174299330-939dd03cc864"),
        portionSize: "1 Clay Cup (150g)",
        spiceLevel: "Sweet",
        rating: "4.9",
        isEveryday: true,
        isAvailable: true,
      },

      // Home-Style Daily Meals
      {
        slugKey: "rice-chicken-curry",
        categoryId: catMap.get("home-style-meals")!,
        name: "Rice & Chicken Curry",
        description:
          "Steamed rice with home-style chicken curry, dal and a fresh cucumber-onion salad.",
        basePriceBdt: 220,
        imageUrl: img("photo-1679279727895-bd5c9fb9c1a0"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.7",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "rice-fish-curry",
        categoryId: catMap.get("home-style-meals")!,
        name: "Rice & Fish Curry",
        description:
          "Steamed rice with fresh rui fish in a light mustard and turmeric gravy, served with dal.",
        basePriceBdt: 240,
        imageUrl: img("photo-1761314037238-e4da5023e844"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.8",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "bengali-thali",
        categoryId: catMap.get("home-style-meals")!,
        name: "Bengali Thali",
        description:
          "Steamed fragrant rice, thick dal, seasonal bhaji, mashed aloo bhorta, chicken curry and tomato chutney.",
        basePriceBdt: 320,
        imageUrl: img("photo-1589778655375-3e622a9fc91c"),
        portionSize: "1 Platter",
        spiceLevel: "Medium",
        rating: "4.9",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "rice-beef-bhuna",
        categoryId: catMap.get("home-style-meals")!,
        name: "Rice & Beef Bhuna",
        description:
          "Steamed rice with slow-fried tender beef bhuna and a comforting side of roasted moong dal.",
        basePriceBdt: 260,
        imageUrl: img("photo-1620894580123-466ad3a0ca06"),
        portionSize: "1:1 Regular",
        spiceLevel: "Spicy",
        rating: "4.8",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "veg-rice-plate",
        categoryId: catMap.get("home-style-meals")!,
        name: "Veg Rice Plate",
        description:
          "Steamed rice with seasonal mixed vegetables, thick lentil soup (dal) and spicy aloo bhorta.",
        basePriceBdt: 160,
        imageUrl: img("photo-1588644525273-f37b60d78512"),
        portionSize: "1:1 Regular",
        spiceLevel: "Mild-Medium",
        rating: "4.6",
        isEveryday: false,
        isAvailable: true,
      },
      {
        slugKey: "rice-egg-curry",
        categoryId: catMap.get("home-style-meals")!,
        name: "Rice & Egg Curry",
        description:
          "Steamed rice with rich duck egg curry, crispy fried potatoes, and a bowl of dal.",
        basePriceBdt: 180,
        imageUrl: img("photo-1723208841184-3d91ba244c60"),
        portionSize: "1:1 Regular",
        spiceLevel: "Medium",
        rating: "4.7",
        isEveryday: false,
        isAvailable: true,
      },
    ]

    const insertedItems = await db
      .insert(menuItems)
      .values(
        itemsData.map(({ slugKey, ...rest }) => ({
          ...rest,
        })),
      )
      .returning()

    // Create lookup map by slugKey
    const itemMap = new Map<string, number>()
    itemsData.forEach((item, index) => {
      itemMap.set(item.slugKey, insertedItems[index].id)
    })

    // 4. Seed 7-Day Meal Schedules
    console.log("📅 Seeding 7-day meal schedules...")

    type ScheduleEntry = {
      slugKey: string
      days: { day: DayOfWeek; isFeatured?: boolean; specialPrice?: number }[]
    }

    const schedulePlan: ScheduleEntry[] = [
      // SATURDAY
      {
        slugKey: "mutton-kacchi",
        days: [{ day: "SATURDAY", isFeatured: true }],
      },
      {
        slugKey: "chicken-tehari",
        days: [{ day: "SATURDAY" }, { day: "MONDAY" }, { day: "WEDNESDAY" }],
      },
      {
        slugKey: "rice-chicken-curry",
        days: [{ day: "SATURDAY" }, { day: "SUNDAY" }, { day: "THURSDAY" }],
      },
      {
        slugKey: "rice-fish-curry",
        days: [{ day: "SATURDAY" }, { day: "MONDAY" }, { day: "WEDNESDAY" }],
      },
      {
        slugKey: "bengali-thali",
        days: [
          { day: "SATURDAY" },
          { day: "SUNDAY" },
          { day: "TUESDAY" },
          { day: "THURSDAY" },
          { day: "FRIDAY" },
        ],
      },

      // SUNDAY
      {
        slugKey: "beef-tehari",
        days: [{ day: "SUNDAY", isFeatured: true }, { day: "TUESDAY" }, { day: "FRIDAY" }],
      },
      {
        slugKey: "chicken-biryani",
        days: [{ day: "SUNDAY" }],
      },
      {
        slugKey: "rice-beef-bhuna",
        days: [{ day: "SUNDAY" }, { day: "MONDAY" }, { day: "WEDNESDAY" }, { day: "FRIDAY" }],
      },

      // MONDAY
      {
        slugKey: "bhuna-khichuri-rezala",
        days: [{ day: "MONDAY", isFeatured: true }],
      },
      {
        slugKey: "veg-rice-plate",
        days: [{ day: "MONDAY" }, { day: "WEDNESDAY" }],
      },

      // TUESDAY
      {
        slugKey: "morog-polao",
        days: [{ day: "TUESDAY", isFeatured: true }],
      },
      {
        slugKey: "rice-egg-curry",
        days: [{ day: "TUESDAY" }, { day: "THURSDAY" }],
      },

      // WEDNESDAY
      {
        slugKey: "hyderabadi-biriyani",
        days: [{ day: "WEDNESDAY", isFeatured: true }],
      },

      // THURSDAY
      {
        slugKey: "mutton-tehari-najirshail",
        days: [{ day: "THURSDAY", isFeatured: true }],
      },
      {
        slugKey: "roast-polao",
        days: [{ day: "THURSDAY" }],
      },

      // FRIDAY
      {
        slugKey: "jummah-kacchi-platter",
        days: [{ day: "FRIDAY", isFeatured: true }],
      },
    ]

    const schedulesToInsert = []
    for (const plan of schedulePlan) {
      const menuItemId = itemMap.get(plan.slugKey)
      if (!menuItemId) continue

      for (const entry of plan.days) {
        schedulesToInsert.push({
          menuItemId,
          dayOfWeek: entry.day,
          specialPriceBdt: entry.specialPrice || null,
          dailyQuota: entry.isFeatured ? 150 : 80,
          isFeatured: entry.isFeatured || false,
        })
      }
    }

    // Also include everyday classics across all 7 days for completeness
    const everydaySlugs = ["borhani", "jali-kabab", "firni", "chicken-roast-side"]
    const allDays: DayOfWeek[] = [
      "SATURDAY",
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
    ]

    for (const slug of everydaySlugs) {
      const menuItemId = itemMap.get(slug)
      if (!menuItemId) continue
      for (const day of allDays) {
        schedulesToInsert.push({
          menuItemId,
          dayOfWeek: day,
          specialPriceBdt: null,
          dailyQuota: 200,
          soldCount: 0,
          isFeatured: false,
        })
      }
    }

    await db.insert(dailyMenuSchedules).values(schedulesToInsert)
    console.log(
      `✅ Seeded ${schedulesToInsert.length} daily schedule assignments across all 7 days with soldCount tracking.`,
    )

    // 5. Create a sample initial order to verify order schema works
    console.log("📝 Seeding a demonstration order...")
    const muttonKacchiId = itemMap.get("mutton-kacchi")!
    const borhaniId = itemMap.get("borhani")!

    const customerUser = userMap.get("customer@banglarbiriyani.com")
    const adminUser = userMap.get("admin@banglarbiriyani.com")

    const [sampleOrder] = await db
      .insert(orders)
      .values({
        orderNumber: "BB-20261028-001",
        userId: customerUser?.id ?? null,
        customerName: customerUser?.fullName || "Tanvir Ahmed",
        customerPhone: customerUser?.phone || "01711000003",
        customerAddress: customerUser?.defaultAddress || "House 14, Road 7, Dhanmondi, Dhaka",
        scheduledDay: "SATURDAY",
        deliverySlot: "Lunch (1:00 PM - 2:00 PM)",
        paymentMethod: "BKASH",
        subtotalBdt: 530,
        deliveryFeeBdt: 60,
        totalBdt: 590,
        status: "CONFIRMED",
        notes: "Please bring extra salad and mint borhani chilled.",
      })
      .returning()

    await db.insert(orderItems).values([
      {
        orderId: sampleOrder.id,
        menuItemId: muttonKacchiId,
        scheduledDay: "SATURDAY",
        itemNameSnapshot: "Saturday Special Shahi Mutton Kacchi",
        quantity: 1,
        unitPriceBdt: 450,
        lineTotalBdt: 450,
      },
      {
        orderId: sampleOrder.id,
        menuItemId: borhaniId,
        scheduledDay: "SATURDAY",
        itemNameSnapshot: "Shahi Borhani (500ml)",
        quantity: 1,
        unitPriceBdt: 80,
        lineTotalBdt: 80,
      },
    ])

    // 6. Record audit log for database seed
    if (adminUser) {
      await db.insert(auditLogs).values({
        actorId: adminUser.id,
        action: "SEED_DATABASE",
        entityType: "SYSTEM",
        entityId: "SYSTEM_INIT",
        metadataJson: JSON.stringify({
          description:
            "Full database seed executed with RBAC users, categories, menu items, quotas, and verified sample order",
          seedTimestamp: new Date().toISOString(),
        }),
      })
      console.log("🛡️ Initial audit log entry registered.")
    }

    console.log(
      `🎉 Successfully seeded Banglar Biriyani database! Order #${sampleOrder.orderNumber} linked to User #${sampleOrder.userId || "Guest"}.`,
    )
  } catch (error) {
    console.error("❌ Error seeding database:", error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

seed()
