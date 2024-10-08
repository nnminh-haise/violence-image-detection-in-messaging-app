import { CreateConversationDto } from './../conversation/dto/create-conversation.dto';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';
import { InjectModel } from '@nestjs/mongoose';
import {
  PopulatedRelationship,
  Relationship,
  RelationshipDocument,
} from './entities/relationship.entity';
import { Model } from 'mongoose';
import { UserService } from 'src/user/user.service';
import { BlockUserDto } from './dto/block-user.dto';
import RelationshipStatus from './entities/relationship.enum';
import { User } from 'src/user/entities/user.entity';
import { MongooseDocumentTransformer } from 'src/helper/mongoose/document-transformer';
import { ConversationService } from 'src/conversation/conversation.service';
import { PopulatedConversation } from 'src/conversation/entities/conversation.entity';
import { MembershipService } from 'src/membership/membership.service';
import { MembershipRole } from 'src/membership/entities/membership-role.enum';

@Injectable()
export class RelationshipService {
  private logger: Logger = new Logger(RelationshipService.name);

  constructor(
    @InjectModel(Relationship.name)
    private relationshipModel: Model<Relationship>,
    private readonly userService: UserService,
    private readonly conversationService: ConversationService,
    private readonly membershipService: MembershipService,
  ) {}

  async create(
    requestedUserId: string,
    payload: CreateRelationshipDto,
  ): Promise<PopulatedRelationship> {
    if (payload.userA === payload.userB) {
      throw new BadRequestException('User A and user B must be different');
    }

    const userA: User = await this.userService.findById(payload.userA);
    if (!userA) throw new BadRequestException('User A not found');

    const userB: User = await this.userService.findById(payload.userB);
    if (!userB) throw new BadRequestException('User B not found');

    const existedRelationship: Relationship = await this.findByUserIds(
      userA.id,
      userB.id,
    );
    if (
      existedRelationship &&
      existedRelationship.status !== RelationshipStatus.AWAY
    ) {
      throw new BadRequestException('Relationship existed');
    }

    if (
      payload.status !== RelationshipStatus.REQUEST_USER_A &&
      payload.status !== RelationshipStatus.REQUEST_USER_B
    ) {
      throw new BadRequestException(
        'Relationship status must be REQUEST_USER_A or REQUEST_USER_B',
      );
    }

    this.relationshipModel
      .createCollection()
      .then(() => this.relationshipModel.startSession());

    try {
      const data: RelationshipDocument = await new this.relationshipModel({
        ...(payload.userA <= payload.userB
          ? { userA: userA.id, userB: userB.id }
          : { userA: userB.id, userB: userA.id }),
        status: payload.status,
      }).save();

      return await this.findById(data._id.toString());
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(
        'Failed to create relationship',
        error,
      );
    }
  }

  async findById(id: string): Promise<PopulatedRelationship> {
    return (await this.relationshipModel
      .findOne({
        _id: id,
        blockedAt: null,
      })
      .populate({
        path: 'userA',
        select: '-__v -password -deletedAt',
        transform: MongooseDocumentTransformer,
      })
      .populate({
        path: 'userB',
        select: '-__v -password -deletedAt',
        transform: MongooseDocumentTransformer,
      })
      .select('-__v -deletedAt')
      .transform(MongooseDocumentTransformer)
      .exec()) as PopulatedRelationship;
  }

  async findMyRelationship(
    relationshipId: string,
    requestedUser: string,
  ): Promise<PopulatedRelationship> {
    const relationship: PopulatedRelationship =
      await this.findById(relationshipId);
    if (!relationship) throw new NotFoundException('Relationship not found');

    const isUserRelationship: boolean =
      (relationship.userA as User).id === requestedUser ||
      (relationship.userB as User).id === requestedUser;

    if (!isUserRelationship)
      throw new UnauthorizedException('Unauthorized user');

    return relationship;
  }

  async findByUserIds(userAId: string, userBId: string): Promise<Relationship> {
    return (await this.relationshipModel
      .findOne({
        ...(userAId <= userBId
          ? {
              userA: userAId,
              userB: userBId,
            }
          : {
              userA: userBId,
              userB: userAId,
            }),
      })
      .select('-__v -deletedAt')
      .transform(MongooseDocumentTransformer)
      .exec()) as Relationship;
  }

  async findAll(
    userId: string,
    page: number,
    size: number,
    sortBy: string,
    orderBy: string,
    status: string,
  ) {
    const skipValue: number = (page - 1) * size;
    const data: PopulatedRelationship[] = (await this.relationshipModel
      .find({
        $or: [{ userA: userId }, { userB: userId }],
        status: {
          $eq: status.toUpperCase(),
        },
        blockedAt: null,
      })
      .populate({
        path: 'userA',
        select: '-__v -password -deletedAt',
        transform: MongooseDocumentTransformer,
      })
      .populate({
        path: 'userB',
        select: '-__v -password -deletedAt',
        transform: MongooseDocumentTransformer,
      })
      .select('-__v -deletedAt')
      .limit(size)
      .skip(skipValue)
      .sort({
        [sortBy]: orderBy.toLowerCase() === 'asc' ? 1 : -1,
      })
      .transform((doc: any) => {
        return doc.map(MongooseDocumentTransformer);
      })
      .exec()) as PopulatedRelationship[];

    return {
      data,
      metadata: {
        pagination: {
          page,
          size,
        },
        count: data.length,
      },
    };
  }

  async confirmFriendship(requestedUserId: string, relationshipId: string) {
    const relationship: PopulatedRelationship =
      await this.findById(relationshipId);
    if (!relationship) {
      throw new NotFoundException('Relationship not found');
    }

    if (relationship.status === RelationshipStatus.FRIENDS) {
      throw new BadRequestException('Users are already friends');
    }

    const userA: User = relationship.userA;
    const userB: User = relationship.userB;
    const hostId: string = requestedUserId;

    try {
      const privateConversationPayload: CreateConversationDto = {
        name: `Private conversation [${relationshipId}]`,
        description: `Private conversation [${relationshipId}]`,
        createdBy: hostId,
        host: hostId,
      };
      const privateConversation: PopulatedConversation =
        await this.conversationService.create(privateConversationPayload);

      const userAMembership = await this.membershipService.create(
        requestedUserId,
        {
          user: userA.id,
          conversation: privateConversation.id,
          role:
            userA.id === requestedUserId
              ? MembershipRole.HOST
              : MembershipRole.MEMBER,
        },
      );

      const userBMembership = await this.membershipService.create(
        requestedUserId,
        {
          user: userB.id,
          conversation: privateConversation.id,
          role:
            userB.id === requestedUserId
              ? MembershipRole.HOST
              : MembershipRole.MEMBER,
        },
      );

      const data: RelationshipDocument = await this.relationshipModel
        .findByIdAndUpdate(
          relationshipId,
          {
            privateConversation: privateConversation.id,
            status: RelationshipStatus.FRIENDS,
          },
          { new: true },
        )
        .exec();
      return await this.findById(data._id.toString());
    } catch (error) {
      console.log('error:', error);
      throw new InternalServerErrorException(
        'Failed to update relationship',
        error,
      );
    }
  }

  async update(
    id: string,
    updateRelationshipDto: UpdateRelationshipDto,
    requestedUser: string,
  ): Promise<PopulatedRelationship> {
    const relationship: PopulatedRelationship = await this.findById(id);
    if (!relationship) throw new NotFoundException('Relationship not found');

    try {
      const data: RelationshipDocument = await this.relationshipModel
        .findByIdAndUpdate(id, { ...updateRelationshipDto }, { new: true })
        .exec();

      return await this.findById(data._id.toString());
    } catch (error) {
      throw new InternalServerErrorException(
        'Failed to update relationship',
        error,
      );
    }
  }

  async blockUser(
    requestedUser: string,
    blockUserDto: BlockUserDto,
  ): Promise<PopulatedRelationship> {
    const blocker: User = await this.userService.findById(
      blockUserDto.blockedBy,
    );
    if (!blocker) throw new NotFoundException('Block by user not found');

    if (blockUserDto.blockedBy !== requestedUser)
      throw new UnauthorizedException('Unauthorized user');

    const targetUser: User = await this.userService.findById(
      blockUserDto.targetUser,
    );
    if (!targetUser) throw new NotFoundException('Target user not found');

    const relationship: Relationship = await this.findByUserIds(
      blockUserDto.blockedBy,
      blockUserDto.targetUser,
    );
    if (!relationship) throw new NotFoundException('Relationship not found');
    if (relationship.blockedAt)
      throw new BadRequestException('Relationship is already blocked');

    try {
      const status: RelationshipStatus =
        blockUserDto.blockedBy === relationship.userA
          ? RelationshipStatus.BLOCKED_USER_A
          : RelationshipStatus.BLOCKED_USER_B;
      const data: RelationshipDocument = await this.relationshipModel
        .findByIdAndUpdate(relationship.id, { status }, { new: true })
        .exec();
      return await this.findById(data._id.toString());
    } catch (error) {
      throw new InternalServerErrorException('Failed to block user', error);
    }
  }
}
