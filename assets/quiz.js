document.querySelectorAll("[data-quiz]").forEach((quiz) => {
  const feedback = quiz.querySelector("[data-feedback]");
  quiz.querySelectorAll("button[data-answer]").forEach((button) => {
    button.addEventListener("click", () => {
      quiz.querySelectorAll("button[data-answer]").forEach((candidate) => {
        candidate.classList.remove("correct", "incorrect");
      });
      const correct = button.dataset.answer === "correct";
      button.classList.add(correct ? "correct" : "incorrect");
      feedback.textContent = correct
        ? button.dataset.correctFeedback
        : button.dataset.incorrectFeedback;
    });
  });
});
