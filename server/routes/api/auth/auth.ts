import { subHours, subMinutes } from "date-fns";
import Router from "koa-router";
import uniqBy from "lodash/uniqBy";
import { TeamPreference } from "@shared/types";
import { getCookieDomain, parseDomain } from "@shared/utils/domains";
import env from "@server/env";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import { Event, Team } from "@server/models";
import AuthenticationHelper from "@server/models/helpers/AuthenticationHelper";
import {
  presentUser,
  presentTeam,
  presentPolicies,
  presentProviderConfig,
  presentAvailableTeam,
} from "@server/presenters";
import ValidateSSOAccessTask from "@server/queues/tasks/ValidateSSOAccessTask";
import { APIContext } from "@server/types";
import { getSessionsInCookie } from "@server/utils/authentication";
import * as T from "./schema";

const router = new Router();

router.post("auth.config", async (ctx: APIContext<T.AuthConfigReq>) => {
  // If self hosted AND there is only one team then that team becomes the
  // brand for the knowledge base and it's guest signin option is used for the
  // root login page.
  if (!env.isCloudHosted()) {
    const team = await Team.scope("withAuthenticationProviders").findOne();

    if (team) {
      ctx.body = {
        data: {
          name: team.name,
          customTheme: team.getPreference(TeamPreference.CustomTheme),
          logo: team.getPreference(TeamPreference.PublicBranding)
            ? team.avatarUrl
            : undefined,
          providers: AuthenticationHelper.providersForTeam(team).map(
            presentProviderConfig
          ),
        },
      };
      return;
    }
  }

  const domain = parseDomain(ctx.request.hostname);

  if (domain.custom) {
    const team = await Team.scope("withAuthenticationProviders").findOne({
      where: {
        domain: ctx.request.hostname,
      },
    });

    if (team) {
      ctx.body = {
        data: {
          name: team.name,
          customTheme: team.getPreference(TeamPreference.CustomTheme),
          logo: team.getPreference(TeamPreference.PublicBranding)
            ? team.avatarUrl
            : undefined,
          hostname: ctx.request.hostname,
          providers: AuthenticationHelper.providersForTeam(team).map(
            presentProviderConfig
          ),
        },
      };
      return;
    }
  }

  // If subdomain signin page then we return minimal team details to allow
  // for a custom screen showing only relevant signin options for that team.
  else if (env.SUBDOMAINS_ENABLED && domain.teamSubdomain) {
    const team = await Team.scope("withAuthenticationProviders").findOne({
      where: {
        subdomain: domain.teamSubdomain,
      },
    });

    if (team) {
      ctx.body = {
        data: {
          name: team.name,
          customTheme: team.getPreference(TeamPreference.CustomTheme),
          logo: team.getPreference(TeamPreference.PublicBranding)
            ? team.avatarUrl
            : undefined,
          hostname: ctx.request.hostname,
          providers: AuthenticationHelper.providersForTeam(team).map(
            presentProviderConfig
          ),
        },
      };
      return;
    }
  }

  // Otherwise, we're requesting from the standard root signin page
  ctx.body = {
    data: {
      providers: AuthenticationHelper.providersForTeam().map(
        presentProviderConfig
      ),
    },
  };
});

router.post("auth.info", auth(), async (ctx: APIContext<T.AuthInfoReq>) => {
  const { user } = ctx.state.auth;
  const sessions = getSessionsInCookie(ctx);
  const signedInTeamIds = Object.keys(sessions);

  const [team, signedInTeams, availableTeams] = await Promise.all([
    Team.scope("withDomains").findByPk(user.teamId, {
      rejectOnEmpty: true,
    }),
    Team.findAll({
      where: {
        id: signedInTeamIds,
      },
    }),
    user.availableTeams(),
  ]);

  // If the user did not _just_ sign in then we need to check if they continue
  // to have access to the workspace they are signed into.
  if (user.lastSignedInAt && user.lastSignedInAt < subHours(new Date(), 1)) {
    await ValidateSSOAccessTask.schedule({ userId: user.id });
  }

  ctx.body = {
    data: {
      user: presentUser(user, {
        includeDetails: true,
      }),
      team: presentTeam(team),
      collaborationToken: user.getCollaborationToken(),
      availableTeams: uniqBy([...signedInTeams, ...availableTeams], "id").map(
        (team) =>
          presentAvailableTeam(
            team,
            signedInTeamIds.includes(team.id) || team.id === user.teamId
          )
      ),
    },
    policies: presentPolicies(user, [team]),
  };
});

router.post(
  "auth.delete",
  auth(),
  transaction(),
  async (ctx: APIContext<T.AuthDeleteReq>) => {
    const { auth, transaction } = ctx.state;
    const { user } = auth;

    await user.rotateJwtSecret({ transaction });
    await Event.create(
      {
        name: "users.signout",
        actorId: user.id,
        userId: user.id,
        teamId: user.teamId,
        data: {
          name: user.name,
        },
        ip: ctx.request.ip,
      },
      {
        transaction,
      }
    );

    ctx.cookies.set("accessToken", "", {
      expires: subMinutes(new Date(), 1),
      domain: getCookieDomain(ctx.hostname),
    });

    ctx.body = {
      success: true,
    };
  }
);

export default router;
