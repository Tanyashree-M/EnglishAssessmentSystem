import os
import psycopg2
from dotenv import load_dotenv
import random

# -------------------------
# Load ENV
# -------------------------
load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")

# -------------------------
# DB Connection
# -------------------------
conn = psycopg2.connect(DATABASE_URL)
conn.autocommit = True

with conn.cursor() as cur:
    cur.execute("SELECT NOW();")
    print("DB Connected:", cur.fetchone())

# -------------------------
# Arms (difficulty levels)
# -------------------------
arms = ['1', '2', '3', '4', '5']

MIN_EXPLORATION = 3
EXPLOIT_PROB = 0.7
MIN_SAMPLES_FOR_EXPLOIT = 3

# -------------------------
# Initialize student arms
# -------------------------
def initialize_student(student_id):
    with conn.cursor() as cur:
        for arm in arms:
            cur.execute("""
                INSERT INTO student_bandit (student_id, arm)
                VALUES (%s, %s)
                ON CONFLICT (student_id, arm) DO NOTHING
            """, (student_id, arm))

# -------------------------
# Predict next difficulty
# -------------------------
def get_next_difficulty(student_id):
    initialize_student(student_id)

    with conn.cursor() as cur:
        cur.execute("""
            SELECT arm, successes, failures
            FROM student_bandit
            WHERE student_id = %s
        """, (student_id,))
        rows = cur.fetchall()

    data = {
        arm: {"successes": 0, "failures": 0}
        for arm in arms
    }

    for row in rows:
        data[row[0]] = {
            "successes": row[1],
            "failures": row[2]
        }

    print(f"\n[DEBUG] Bandit data → {data}")

    # 1️⃣ Initial Exploration
    under_sampled = [
        arm for arm in arms
        if (data[arm]["successes"] + data[arm]["failures"]) < MIN_EXPLORATION
    ]

    if under_sampled:
        chosen = random.choice(under_sampled)
        print(f"[EXPLORE - INITIAL] Selected → {chosen}")
        return chosen

    # 2️⃣ Beta Mean Calculation
    print("\n[DEBUG] Bayesian Means per arm:")

    best_mean = -1
    best_arms = []

    for arm in arms:
        s = data[arm]["successes"]
        f = data[arm]["failures"]
        samples = s + f

        # Always compute mean (even if low samples)
        a = s + 1
        b = f + 1
        mean = a / (a + b)

        print(f"Arm {arm} → successes={s}, failures={f}, mean={mean:.3f}")

        # Only consider for exploitation if enough samples
        if samples >= MIN_SAMPLES_FOR_EXPLOIT:
            if mean > best_mean:
                best_mean = mean
                best_arms = [arm]
            elif mean == best_mean:
                best_arms.append(arm)

    if not best_arms:
        chosen = random.choice(arms)
        print(f"[FALLBACK] Selected → {chosen}")
        return chosen

    # 3️⃣ Exploit vs Explore
    if random.random() < EXPLOIT_PROB:
        chosen = max(best_arms, key=int)
        print(f"[EXPLOIT] Selected → {chosen}")
        return chosen

    explore_arms = [arm for arm in arms if arm not in best_arms]
    chosen = random.choice(explore_arms) if explore_arms else random.choice(arms)

    print(f"[EXPLORE] Selected → {chosen}")
    return chosen


# -------------------------
# Update bandit
# -------------------------
def update_bandit(student_id, decision, reward):
    decision = str(decision)
    reward = int(reward)

    print(f"[MAB UPDATE] decision={decision}, reward={reward}")

    initialize_student(student_id)

    with conn.cursor() as cur:
        if reward == 1:
            cur.execute("""
                UPDATE student_bandit
                SET successes = successes + 1
                WHERE student_id = %s AND arm = %s
            """, (student_id, decision))
        else:
            cur.execute("""
                UPDATE student_bandit
                SET failures = failures + 1
                WHERE student_id = %s AND arm = %s
            """, (student_id, decision))

    print("[MAB UPDATE] DB updated")


# -------------------------
# Reset bandit
# -------------------------
def reset_bandit(student_id):
    with conn.cursor() as cur:
        cur.execute("""
            DELETE FROM student_bandit
            WHERE student_id = %s
        """, (student_id,))