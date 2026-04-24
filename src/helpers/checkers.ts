import { GitHubPullRequest, GitHubPullRequestReviewState } from "../github-types";
import { IssueActivity } from "../issue-activity";
import { ContextPlugin } from "../types/plugin-input";

type RequestedReviewer = NonNullable<GitHubPullRequest["requested_reviewers"]>[number];

export function isCollaborative(data: Readonly<IssueActivity>) {
  if (!data.self?.closed_by || !data.self.user) return false;
  const issueCreator = data.self.user;

  if (data.self.closed_by.id === issueCreator.id) {
    const pricingEventsByNonAssignee = data.events.find(
      (event) =>
        event.event === "labeled" &&
        "label" in event &&
        (event.label.name.startsWith("Time: ") || event.label.name.startsWith("Priority: ")) &&
        event.actor.id !== issueCreator.id
    );
    return !!pricingEventsByNonAssignee || !!nonAssigneeApprovedReviews(data);
  }
  return true;
}

export function nonAssigneeApprovedReviews(data: Readonly<IssueActivity>) {
  const linkedPullRequest = data.linkedMergedPullRequests[0];
  if (!linkedPullRequest) {
    return false;
  }

  if (data.self?.pull_request) {
    const pullRequestAuthorId = linkedPullRequest.self?.user?.id ?? data.self.user?.id;
    return hasApprovedReviewByUserOtherThan(linkedPullRequest.reviews, pullRequestAuthorId);
  }

  const assigneeId = data.self?.assignee?.id;
  if (!assigneeId || !linkedPullRequest.self) {
    return false;
  }

  return hasIssueContextApprovedReview(linkedPullRequest.self, linkedPullRequest.reviews, assigneeId);
}

function hasApprovedReviewByUserOtherThan(reviews: GitHubPullRequestReviewState[] | null | undefined, userId?: number) {
  if (!userId || !reviews) {
    return false;
  }

  return reviews.some((review) => review.user?.id !== userId && review.state === "APPROVED");
}

function hasIssueContextApprovedReview(
  pullRequest: GitHubPullRequest,
  reviews: GitHubPullRequestReviewState[] | null | undefined,
  assigneeId: number
) {
  if (!reviews) {
    return false;
  }

  return reviews.some(
    (review) =>
      Boolean(review.user?.id) &&
      review.user?.id !== assigneeId &&
      review.state === "APPROVED" &&
      !isReviewRequestedForUser(pullRequest, review)
  );
}

function isReviewRequestedForUser(pullRequest: GitHubPullRequest, review: GitHubPullRequestReviewState) {
  if (!("requested_reviewers" in pullRequest)) {
    return false;
  }

  return (
    pullRequest.requested_reviewers?.some((reviewer: RequestedReviewer) => reviewer.id === review.user?.id) ?? false
  );
}

/*
 * Returns true if a given user has admin permission in the specific repo, otherwise checks for admin / billing manager
 * within the parent organization.
 */
export async function isAdmin(username: string, context: ContextPlugin): Promise<boolean> {
  const octokit = context.octokit;
  try {
    const permissionLevel = await octokit.rest.repos.getCollaboratorPermissionLevel({
      username,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
    });
    context.logger.debug(`Retrieved collaborator permission level for ${username}.`, {
      username,
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      isAdmin: permissionLevel.data.user?.permissions?.admin,
    });
    if (permissionLevel.data.user?.permissions?.admin) {
      return true;
    }
    const userPerms = await octokit.rest.orgs.getMembershipForUser({
      org: context.payload.repository.owner.login,
      username: username,
    });
    return userPerms.data.role === "admin" || userPerms.data.role === "billing_manager";
  } catch (e) {
    context.logger.debug(`${username} is not a member of ${context.payload.repository.owner.login}`, { e });
    return false;
  }
}
