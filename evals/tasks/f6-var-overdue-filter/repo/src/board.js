'use strict';

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isOverdue(task, now = new Date()) {
  if (task.done || !task.due) return false;
  return Date.parse(task.due) < startOfDay(now).getTime();
}

function dueThisWeek(tasks, now = new Date()) {
  const start = startOfDay(now).getTime();
  const end = start + 7 * 864e5;
  return tasks.filter((t) => !t.done && t.due && Date.parse(t.due) >= start && Date.parse(t.due) < end);
}

function summary(tasks, now = new Date()) {
  return {
    open: tasks.filter((t) => !t.done).length,
    overdue: tasks.filter((t) => isOverdue(t, now)).length,
    thisWeek: dueThisWeek(tasks, now).length,
  };
}

module.exports = { isOverdue, dueThisWeek, summary };
