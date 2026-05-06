import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { requireProjectMember } from '../middleware/requireProjectMember.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as projects from '../services/projects.js';
import * as projectMembers from '../services/projectMembers.js';
import * as recurring from '../services/recurring.js';

export const projectsRouter = Router();

projectsRouter.get('/', requireUser, (req, res) => {
  const includeArchived = req.query?.include_archived === '1';
  const clientId = req.query?.client_id ? Number.parseInt(req.query.client_id, 10) : undefined;
  res.json({
    projects: projects.listForUser(db, req.user, { includeArchived, clientId }),
  });
});

projectsRouter.post('/', requireSuperAdmin, (req, res) => {
  const r = projects.create(db, req.body || {}, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) {
    const status =
      r.reason === 'duplicate' ? 409 :
      r.reason === 'client_not_found' ? 404 :
      400;
    return res.status(status).json({ error: r.reason });
  }
  res.status(201).json({ project: r.project });
});

projectsRouter.get('/:id', requireProjectMember, (req, res) => {
  const project = projects.get(db, Number.parseInt(req.params.id, 10), req.user);
  res.json({ project });
});

projectsRouter.patch('/:id', requireSuperAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = projects.update(db, id, req.body || {}, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) {
    const status =
      r.reason === 'not_found' ? 404 :
      r.reason === 'duplicate' ? 409 :
      r.reason === 'client_not_found' ? 404 :
      400;
    return res.status(status).json({ error: r.reason });
  }
  res.json({ project: r.project });
});

projectsRouter.post('/:id/archive', requireSuperAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = projects.archive(db, id, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(404).json({ error: r.reason });
  res.json({ project: r.project });
});

projectsRouter.post('/:id/unarchive', requireSuperAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = projects.unarchive(db, id, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(404).json({ error: r.reason });
  res.json({ project: r.project });
});

// Member sub-routes mounted as a child of /api/projects so they share :id.
projectsRouter.get('/:id/members', requireProjectMember, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  res.json({ members: projectMembers.list(db, projectId, req.user) });
});

projectsRouter.post('/:id/members', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = projectMembers.add(db, projectId, req.body || {}, {
    actorId: req.user.id,
    ip: clientIp(req),
  });
  if (!r.ok) {
    const status =
      r.reason === 'project_not_found' ? 404 :
      r.reason === 'unknown_user' ? 404 :
      r.reason === 'already_member' ? 409 :
      400;
    return res.status(status).json({ error: r.reason });
  }
  res.status(201).json({ member: r.member });
});

projectsRouter.patch('/:id/members/:memberId', requireSuperAdmin, (req, res) => {
  const memberId = Number.parseInt(req.params.memberId, 10);
  const r = projectMembers.updateRate(db, memberId, req.body || {}, {
    actorId: req.user.id,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 400).json({ error: r.reason });
  res.json({ member: r.member });
});

projectsRouter.delete('/:id/members/:memberId', requireSuperAdmin, (req, res) => {
  const memberId = Number.parseInt(req.params.memberId, 10);
  const r = projectMembers.remove(db, memberId, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(404).json({ error: r.reason });
  res.json({ member: r.member });
});

// Stage 8 — recurring schedule sub-routes. Super-admin only (subs never see
// invoices, so they have no business setting up one's recurring schedule).
function recurringStatusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'project_not_found':
      return 404;
    case 'paused':
      return 409;
    case 'invalid_mode':
    case 'invalid_day_of_month':
    case 'fixed_amount_required':
    case 'fixed_description_required':
    case 'project_required':
      return 400;
    default:
      return 500;
  }
}

projectsRouter.get('/:id/recurring', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const schedule = recurring.getForProject(db, projectId, req.user);
  if (!schedule) return res.status(404).json({ error: 'not_found' });
  res.json({ schedule });
});

projectsRouter.put('/:id/recurring', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = recurring.setSchedule(db, projectId, req.body || {}, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(recurringStatusFor(r.reason)).json({ error: r.reason });
  res.json({ schedule: r.schedule });
});

projectsRouter.delete('/:id/recurring', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = recurring.deleteSchedule(db, projectId, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(recurringStatusFor(r.reason)).json({ error: r.reason });
  res.json({ ok: true });
});

projectsRouter.post('/:id/recurring/pause', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = recurring.pause(db, projectId, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(recurringStatusFor(r.reason)).json({ error: r.reason });
  res.json({ schedule: r.schedule });
});

projectsRouter.post('/:id/recurring/resume', requireSuperAdmin, (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = recurring.resume(db, projectId, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(recurringStatusFor(r.reason)).json({ error: r.reason });
  res.json({ schedule: r.schedule });
});

projectsRouter.post('/:id/recurring/run-now', requireSuperAdmin, async (req, res) => {
  const projectId = Number.parseInt(req.params.id, 10);
  const r = await recurring.runOnce(db, projectId, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(recurringStatusFor(r.reason)).json({ error: r.reason });
  // Refresh the schedule so the UI sees the bumped next_run_date / last_*.
  const schedule = recurring.getForProject(db, projectId, req.user);
  res.json({ result: r.result, schedule });
});
