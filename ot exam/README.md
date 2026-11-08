# Pre Exam Site

A Java-powered multiple-choice exam website with a student exam experience and an admin question/settings editor. The interface is built with HTML, CSS, and JavaScript; the server and scoring logic use Java 17.

## Features

- Configure exam title, duration, marks for a correct answer, and negative marks for a wrong answer.
- Add, edit, and remove questions and answer options in the admin panel.
- Students can navigate questions, see a countdown, and submit answers.
- Answers are scored by the Java server. The result includes correct, incorrect, skipped, and total marks, plus answer review.
- Admins can review completed attempts, including scores and per-question answers.
- Add an optional PNG, JPEG, WebP, or GIF image (up to 600 KB) to any question.
- Exam edits are stored in `data/exam.json`; completed results are stored in `data/results.json`.

## Run

1. Install a JDK 17+ and Apache Maven.
2. From this folder, run `mvn package`.
3. Run `java -jar target/pre-exam-site-1.0.0-jar-with-dependencies.jar`.
4. Open `http://localhost:8080` in a browser.

On Windows, after the project has been built once, double-click `Start Pre Exam Site.bat` to start the server and open the site. Leave the server window open while you use the site; close that window to stop it. `localhost` is only accessible from this computer, not as a public Internet website.

Open **Admin** in the top-right corner to edit the exam. The local development password is `admin123`. Set the `PREEXAM_ADMIN_PASSWORD` environment variable to a strong password before running the server for any shared environment.

Set the `PORT` environment variable to use a different port. Set the `preexam.data` Java system property to choose a different exam data file.

## Important security note

The admin API is password-protected. Results are stored locally without student names or accounts, but may still contain sensitive exam information. Protect the data directory, set a strong admin password, and use HTTPS before using this for a shared environment or sensitive medical assessments.
