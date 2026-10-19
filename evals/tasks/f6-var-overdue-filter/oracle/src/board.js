'use strict';

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Date-only strings parse as UTC midnight; treat `due` as a local calendar date.
function dueTime(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }

function isOverdue(task, now = new Date()) {
  if (task.done || !task.due) return false;
  return dueTime(task.due) < startOfDay(now).getTime();
}

function dueThisWeek(tasks, now = new Date()) {
  const start = startOfDay(now).getTime();
  const end = start + 7 * 864e5;
  return tasks.filter((t) => !t.done && t.due && dueTime(t.due) >= start && dueTime(t.due) < end);
}

function summary(tasks, now = new Date()) {
  return {
    open: tasks.filter((t) => !t.done).length,
    overdue: tasks.filter((t) => isOverdue(t, now)).length,
    thisWeek: dueThisWeek(tasks, now).length,
  };
}

module.exports = { isOverdue, dueThisWeek, summary };
