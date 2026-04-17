from flask import Flask, request, jsonify
from mab_model import get_next_difficulty, update_bandit, reset_bandit

app = Flask(__name__)

# -------------------------
# Get next difficulty
# -------------------------
@app.route("/question/next", methods=["GET"])
def next_question():
    try:
        student_id = request.args.get("student_id")

        if not student_id:
            return jsonify({"error": "student_id required"}), 400

        next_diff = get_next_difficulty(student_id)

        # Safety: always return int
        try:
            next_diff = int(next_diff)
        except Exception:
            next_diff = 3

        return jsonify({"next_difficulty": next_diff})

    except Exception as e:
        print("❌ Error in /question/next:", str(e))
        return jsonify({"error": "Internal server error"}), 500


# -------------------------
# Submit answer (update bandit)
# -------------------------
@app.route("/answer", methods=["POST"])
def submit_answer():
    try:
        data = request.json or {}

        student_id = data.get("student_id")
        decision = data.get("decision")
        reward = data.get("reward")

        if not student_id:
            return jsonify({"error": "student_id required"}), 400

        try:
            decision = int(decision)
            reward = int(reward)
        except Exception:
            return jsonify({"error": "Invalid decision or reward"}), 400

        update_bandit(student_id, decision, reward)

        return jsonify({"status": "updated successfully!"})

    except Exception as e:
        print("❌ Error in /answer:", str(e))
        return jsonify({"error": "Internal server error"}), 500


# -------------------------
# Reset bandit
# -------------------------
@app.route("/reset", methods=["POST"])
def reset_bandit_api():
    try:
        data = request.json or {}
        student_id = data.get("student_id")

        if not student_id:
            return jsonify({"error": "student_id required"}), 400

        reset_bandit(student_id)

        return jsonify({"status": "bandit reset"})

    except Exception as e:
        print("❌ Error in /reset:", str(e))
        return jsonify({"error": "Internal server error"}), 500


@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "MAB service running"})


# -------------------------
# Run app
# -------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)